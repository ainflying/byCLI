import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publisherDOM } from './_shared/publisher-dom.js';
import { manageDraft, prepareDraft, PUBLISH_COLUMNS, operationResult } from './_shared/publisher.js';
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bycli-zhihu-')); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });
const id = '2095491476746777099';
const serverArticle = { status: 200, id, state: 'draft', owner: 'test-owner', title: '标题', body: '正文', image_keys: [], cover_key: null };
const op = () => ({ version: 1, site: 'zhihu', kind: 'article', operation_id: randomUUID(), submitted: false,
    created_at: '2026-10-19T00:00:00Z', images: [], title: '标题', body: '正文', ai_generated: 'yes', image_count: 0, status: 'draft_verified', verified: true,
    author_identity: 'test-owner', draft_id: id, editor_url: `https://zhuanlan.zhihu.com/p/${id}/edit`, browser_target: 'retained' });
async function journal(value = op()) { const file = join(dir, 'operation.json'); await writeFile(file, JSON.stringify(value)); return { file, value }; }
// Minimal synthetic publisher fixture, not a captured real browser acceptance test.
function article(value) {
    const d = new JSDOM(`<main><textarea placeholder="请输入标题（最多 100 个字）">${value.title}</textarea><div class="public-DraftEditor-content" contenteditable="true">${value.body}</div><div><label>创作声明</label><div><button id="Popover1-toggle" aria-haspopup="true" aria-expanded="false">包含 AI 辅助创作 作者对内容负责</button></div></div><div class="DraftStatusTip">刚刚 · 草稿</div><button id="publish">发布</button></main>`, { url: value.editor_url, runScripts: 'outside-only' });
    d.window.document.documentElement.setAttribute('data-bycli-zhihu-operation', value.operation_id);
    return d;
}
describe('publisher scoped DOM contract', () => {
    it('separates saved draft and permitted submit, then rejects a missing declaration', () => {
        const o = op(), d = article(o);
        const run = action => d.window.eval(`(${publisherDOM.toString()})('article',${JSON.stringify(action)},${JSON.stringify(o.operation_id)},'yes')`);
        expect(run('submit')).toMatchObject({ ready: true, saved: true, ai_selected: true, draft_id: id });
        expect(run('submit').selector).toContain('submit');
        d.window.document.querySelector('#Popover1-toggle').textContent = '无声明';
        expect(run('submit').selector).toBeNull(); d.window.close();
    });
    it('never chooses a hidden, ambiguous or verification-blocked publish button', () => {
        const o = op(), d = article(o);
        const run = () => d.window.eval(`(${publisherDOM.toString()})('article','submit',${JSON.stringify(o.operation_id)},'yes')`);
        d.window.document.querySelector('#publish').hidden = true; expect(run().selector).toBeNull();
        d.window.document.querySelector('#publish').hidden = false;
        d.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<button>发布</button>'); expect(run().selector).toBeNull();
        d.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<div>安全验证</div>'); expect(run()).toMatchObject({ blocked: true, selector: null });
        d.window.close();
    });
});
describe('publisher durable submission lifecycle', () => {
    it('waits for submission settlement before draining a pending native receipt', async () => {
        const { file, value } = await journal(); const d = article(value);
        let clicked = false, polls = 0;
        const page = {
            setActivePage: vi.fn(), startNetworkCapture: vi.fn(async () => true), wait: vi.fn(),
            evaluate: async js => {
                if (js.startsWith('(async function accountDOM')) return { status: 200, slug: 'test-owner' };
                if (js.startsWith('(async function articleDraftDOM')) return serverArticle;
                if (clicked && ++polls === 3) d.window.document.body.insertAdjacentHTML('beforeend', '<div>发布成功</div>');
                return d.window.eval(js);
            },
            click: vi.fn(async () => { clicked = true; }),
            readNetworkCapture: vi.fn(async () => {
                if (!clicked) return [];
                expect(polls).toBeGreaterThanOrEqual(3);
                return [{ url: 'https://www.zhihu.com/api/v4/content/publish', method: 'POST', timestamp: Date.now(), responseStatus: 200,
                    responsePreview: JSON.stringify({ code: 0, data: { publish_type: 'article', result: `{"id":${id}}` } }) }];
            }),
        };
        const [row] = await manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article');
        expect(row).toMatchObject({ status: 'submitted', target: `article:${id}`, message: 'Platform receipt confirms submission; verify public content separately' });
        expect(page.readNetworkCapture).toHaveBeenCalledTimes(2); expect(page.click).toHaveBeenCalledTimes(1); d.window.close();
    });
    it('marks uncertainty before the click, and never repeats after transport failure', async () => {
        const { file, value } = await journal(); const d = article(value);
        const page = { setActivePage: vi.fn(), evaluate: js => js.startsWith('(async function accountDOM') ? { status: 200, slug: 'test-owner' } : js.startsWith('(async function articleDraftDOM') ? serverArticle : d.window.eval(js), click: vi.fn(async () => {
            expect(JSON.parse(await readFile(file))).toMatchObject({ submitted: true, status: 'submit_unknown' });
            throw Error('transport interrupted');
        }) };
        await expect(manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article')).rejects.toThrow('transport');
        expect((await manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article'))[0]).toMatchObject({ status: 'submit_unknown', submitted: true });
        expect(page.click).toHaveBeenCalledTimes(1); d.window.close();
    });
    it.each(['content', 'binding', 'draft-id', 'saving'])('refuses changed %s without clicking', async change => {
        const { file, value } = await journal(); const d = article(value);
        if (change === 'content') d.window.document.querySelector('[contenteditable]').textContent = 'manual edit';
        if (change === 'binding') d.window.document.documentElement.removeAttribute('data-bycli-zhihu-operation');
        if (change === 'saving') d.window.document.querySelector('.DraftStatusTip').textContent = '保存中';
        if (change === 'draft-id') d.reconfigure({ url: 'https://zhuanlan.zhihu.com/p/123/edit' });
        const page = { setActivePage: vi.fn(), evaluate: js => js.startsWith('(async function accountDOM') ? { status: 200, slug: 'test-owner' } : js.startsWith('(async function articleDraftDOM') ? (change === 'saving' ? { ...serverArticle, body: 'unsaved prior content' } : serverArticle) : d.window.eval(js), click: vi.fn() };
        await expect(manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article')).rejects.toThrow();
        expect(page.click).not.toHaveBeenCalled(); d.window.close();
    });
    it('defaults to reopen, and refuses invalid modes before a click', async () => {
        const { file } = await journal(); const page = { goto: vi.fn().mockRejectedValue(Error('reopen called')), click: vi.fn() };
        await expect(manageDraft(page, { operation: file, execute: true }, 'article')).rejects.toThrow('reopen called');
        await expect(manageDraft(page, { operation: file, execute: true, mode: 'anything' }, 'article')).rejects.toThrow('--mode');
        expect(page.click).not.toHaveBeenCalled();
    });
    it('requires explicit execution before any browser or journal mutation', async () => {
        const page = { goto: vi.fn() };
        await expect(prepareDraft(page, { operation: join(dir, 'operation.json') }, 'article')).rejects.toThrow('--execute');
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('keeps output column order and does not call a local journal published', () => {
        const value = op(); expect(Object.keys(operationResult(value)[0])).toEqual(PUBLISH_COLUMNS);
        expect(operationResult(value)[0].public_url).toBeNull();
    });
});

import { exactResultId, publishReceipt } from './_shared/receipt.js';
describe('precision-safe publish receipts', () => {
    it.each([
        ['{"id":2095571610795258832,"author":{"id":22}}', '2095571610795258832'],
        ['{"video":{"id":33},"id":"2095571610795258832"}', '2095571610795258832'],
        ['{"text":"escaped \\\"id\\\":99", "id":123}', '123'],
        ['{"author":{"id":33}}', null],
    ])('extracts only the top-level exact identity', (json, expected) => expect(exactResultId(json)).toBe(expected));
    it('rejects an already rounded unsafe Number', () => expect(exactResultId({ id: Number(id) })).toBeNull());
    it('retains the platform pin type for a video receipt and does not claim public confirmation', () => {
        const value = { ...op(), kind: 'video' };
        const entry = { url: 'https://www.zhihu.com/api/v4/content/publish', method: 'POST', timestamp: 100, responseStatus: 200,
            responsePreview: JSON.stringify({ code: 0, data: { publish_type: 'pin', result: `{"id":${id},"video":[{"id":33}]}` } }) };
        expect(publishReceipt(entry, value, 99)).toEqual({ status: 'submitted', type: 'pin', id });
        expect(publishReceipt(entry, value, 101)).toBeNull();
        expect(publishReceipt({ ...entry, url: 'https://evil.example/api/v4/content/publish' }, value, 99)).toBeNull();
        expect(() => publishReceipt(entry, { ...value, draft_id: '1' }, 99)).toThrow('identity');
    });
});

it('refuses a changed account before any publish click', async () => {
    const { file, value } = await journal(); const d = article(value);
    const page = { setActivePage: vi.fn(), evaluate: js => js.startsWith('(async function accountDOM') ? { status: 200, slug: 'other-owner' } : js.startsWith('(async function articleDraftDOM') ? serverArticle : d.window.eval(js), click: vi.fn() };
    await expect(manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article')).rejects.toThrow('account changed');
    expect(page.click).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(file)).submitted).toBe(false); d.window.close();
});

it('accepts a hidden save badge only after persisted readback and with unchanged content', async () => {
    const { file, value } = await journal(); const d = article(value);
    d.window.document.querySelector('.DraftStatusTip').remove();
    const page = { setActivePage: vi.fn(), evaluate: js => js.startsWith('(async function accountDOM') ? { status: 200, slug: 'test-owner' } : js.startsWith('(async function articleDraftDOM') ? serverArticle : d.window.eval(js), click: vi.fn().mockRejectedValue(Error('after click')) };
    await expect(manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article')).rejects.toThrow('after click');
    expect(page.click).toHaveBeenCalledTimes(1); d.window.close();
});

it('recognizes the saving icon outside DraftStatusTip and blocks a submitted cover retry', async () => {
    const value = op(), d = article(value); d.window.document.querySelector('.DraftStatusTip').remove();
    d.window.document.querySelector('main').insertAdjacentHTML('beforeend', '<div>草稿保存中<svg class="ZDI--CloudUpArrow24"></svg></div>');
    expect(d.window.eval(`(${publisherDOM.toString()})('article','status',${JSON.stringify(value.operation_id)},'yes')`).save_state).toBe('saving');
    const { file } = await journal({ ...value, submitted: true, cover: { path: 'cover.png' } });
    const page = { goto: vi.fn(), uploadFiles: vi.fn() };
    await expect(manageDraft(page, { operation: file, mode: 'repair-cover', execute: true }, 'article')).rejects.toThrow('unsubmitted');
    expect(page.goto).not.toHaveBeenCalled(); expect(page.uploadFiles).not.toHaveBeenCalled(); d.window.close();
});

it('does not resubmit when the operator already published from the retained editor', async () => {
    const { file, value } = await journal(); const d = article(value);
    d.window.document.body.insertAdjacentHTML('beforeend', '<div>发布成功</div>');
    const page = { setActivePage: vi.fn(), evaluate: js => js.startsWith('(async function accountDOM') ? { status: 200, slug: 'test-owner' } : js.startsWith('(async function articleDraftDOM') ? serverArticle : d.window.eval(js), click: vi.fn() };
    expect((await manageDraft(page, { operation: file, mode: 'submit', execute: true }, 'article'))[0]).toMatchObject({ status: 'submitted', submitted: true });
    expect(page.click).not.toHaveBeenCalled(); d.window.close();
});
