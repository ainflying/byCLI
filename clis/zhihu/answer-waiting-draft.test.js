import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRegistry } from '@sovovs/bycli/registry';
import './answer-waiting-draft.js';

const questionId = '2077824745589028563';
const questionUrl = `https://www.zhihu.com/question/${questionId}`;
const cmd = () => getRegistry().get('zhihu/answer-waiting-draft');
function browser({ published = false, content = '', auth = false, loseSave = false, saveFails = false, rich = false } = {}) {
    let url = questionUrl;
    let open = false;
    let text = content;
    let stored = content;
    let dirty = false;
    let position = 'replace';
    const actions = [];
    const page = {
        actions,
        goto: vi.fn(async next => { url = next; open = !published && next.endsWith('#write'); text = stored; }),
        wait: vi.fn(),
        insertText: vi.fn(async payload => {
            actions.push('insert'); dirty = true;
            text = position === 'append' ? text + payload : position === 'prepend' ? payload + text : payload;
        }),
        evaluate: vi.fn(async js => {
            if (js.startsWith('(function inspectDraftPage')) {
                if (auth) return { status: 'auth' };
                if (dirty && !saveFails) { if (!loseSave) stored = text; dirty = false; }
                return {
                    status: open ? 'editor' : 'page', url, title: '测试问题', mode: published ? 'edit' : 'new',
                    ownAnswerUrl: published && !url.includes('/answer/') ? `${questionUrl}/answer/123` : '',
                    answerId: url.includes('/answer/') ? '123' : '',
                    text, saved: !dirty && !!text, hasRichContent: rich, canSaveAndLeave: true,
                };
            }
            if (js.startsWith('(function clickDraftControl')) {
                const args = JSON.parse('[' + js.slice(js.lastIndexOf('})(') + 3, -1) + ']');
                actions.push(args[1]);
                if (args[1] === 'open') open = true;
                else if (args[1] === 'save') open = false;
                return true;
            }
            if (js.startsWith('(function prepareDraftInsertion')) {
                const args = JSON.parse('[' + js.slice(js.lastIndexOf('})(') + 3, -1) + ']');
                if (args[1] !== text) return { ok: false, reason: 'content_changed' };
                position = args[2];
                return { ok: true };
            }
            throw new Error('Unexpected browser operation: ' + js.slice(0, 80));
        }),
    };
    return page;
}

describe('zhihu answer-waiting-draft', () => {
    it('skips the browser entirely for dry-run', () => {
        expect(cmd().browser).toBe('conditional');
        expect(cmd().requiresBrowser({ target: questionId, 'dry-run': true })).toBe(false);
        expect(cmd().requiresBrowser({ target: questionId, execute: true })).toBe(true);
    });
    it('requires explicit execution and supports a browser-free dry run', async () => {
        const page = browser();
        await expect(cmd().func(page, { target: questionId, text: '正文' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const result = await cmd().func(null, { target: questionId, text: '正文', 'dry-run': true });
        expect(result[0]).toMatchObject({ status: 'preview', question_id: questionId, content: '正文' });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('creates, reloads, verifies and closes a new answer draft without publishing', async () => {
        const page = browser();
        const result = await cmd().func(page, { target: questionId, text: '第一段\n\n第二段', execute: true });
        expect(result[0]).toMatchObject({ status: 'success', outcome: 'saved', mode: 'new', verified: true, published: false, editor_open: false });
        expect(page.insertText).toHaveBeenCalledWith('第一段\n\n第二段');
        expect(page.goto).toHaveBeenCalledWith('about:blank');
        expect(page.actions.every(a => ['open', 'save', 'insert'].includes(a))).toBe(true);
    });
    it('follows the own-answer link and updates an edit draft', async () => {
        const page = browser({ published: true, content: '旧稿' });
        const result = await cmd().func(page, { target: questionId, text: '新稿', existing: 'replace', mode: 'edit', execute: true });
        expect(page.goto).toHaveBeenCalledWith(`${questionUrl}/answer/123#write`);
        expect(result[0]).toMatchObject({ mode: 'edit', answer_id: '123' });
    });
    it.each(['append', 'prepend'])('supports %s without rewriting existing rich content', async existing => {
        const page = browser({ content: '旧稿', rich: true });
        const rows = await cmd().func(page, { target: questionId, text: '新稿', existing, separator: '\n---\n', execute: true, 'close-editor': false });
        expect(rows[0]).toMatchObject({ verified: true, editor_open: true });
        expect(page.insertText).toHaveBeenCalledWith(existing === 'append' ? '\n---\n新稿' : '新稿\n---\n');
    });
    it('protects existing text and image-only drafts by default', async () => {
        for (const options of [{ content: '旧稿' }, { content: '', rich: true }]) {
            const page = browser(options);
            await expect(cmd().func(page, { target: questionId, text: '新稿', execute: true })).rejects.toMatchObject({ code: 'DRAFT_EXISTS' });
            expect(page.insertText).not.toHaveBeenCalled();
        }
    });
    it('does not insert identical content a second time', async () => {
        const page = browser({ content: '已有正文' });
        const rows = await cmd().func(page, { target: questionId, text: '已有正文', execute: true });
        expect(rows[0]).toMatchObject({ outcome: 'unchanged', verified: true });
        expect(page.insertText).not.toHaveBeenCalled();
    });
    it.each([[true, 'new'], [false, 'edit']])('rejects incompatible mode before typing', async (published, mode) => {
        const page = browser({ published });
        await expect(cmd().func(page, { target: questionId, text: '正文', mode, execute: true })).rejects.toMatchObject({ code: 'ACTION_NOT_AVAILABLE' });
        expect(page.insertText).not.toHaveBeenCalled();
    });
    it('checks the question title before typing', async () => {
        const page = browser();
        await expect(cmd().func(page, { target: questionId, text: '正文', 'expected-title': '别的问题', execute: true })).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
        expect(page.insertText).not.toHaveBeenCalled();
    });
    it('reports login, failed saves and non-persistent saves', async () => {
        await expect(cmd().func(browser({ auth: true }), { target: questionId, text: '正文', execute: true })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
        await expect(cmd().func(browser({ saveFails: true }), { target: questionId, text: '正文', timeout: 1, execute: true })).rejects.toMatchObject({ code: 'DRAFT_SAVE_TIMEOUT' });
        await expect(cmd().func(browser({ loseSave: true }), { target: questionId, text: '正文', timeout: 1, execute: true })).rejects.toMatchObject({ code: 'DRAFT_VERIFY_FAILED' });
    });
    it('reads UTF-8 files and applies prefix and suffix', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'zhihu-draft-'));
        try {
            const file = join(dir, 'answer.txt');
            await writeFile(file, '文件正文');
            const page = browser();
            await cmd().func(page, { target: questionId, file, prefix: '前言\n', suffix: '\n结尾', execute: true });
            expect(page.insertText).toHaveBeenCalledWith('前言\n文件正文\n结尾');
            await expect(cmd().func(page, { target: questionId, text: '冲突', file, execute: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
