import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { inspectDraftPage, prepareDraftInsertion, clickDraftControl, resolveDraftOptions, planDraftContent } from './draft-shared.js';

const id = '2077824745589028563';
const url = `https://www.zhihu.com/question/${id}`;
export function fixture({ text = '', mode = 'new', saved = false, extra = '' } = {}) {
    return `<h1>测试问题</h1><form class="AnswerForm"><div class="public-DraftEditor-content" contenteditable="true" role="textbox">${text.split('\n').map(t => `<div data-block="true">${t}</div>`).join('')}</div>
    ${saved ? '<div class="DraftStatusTip">刚刚 · 草稿<svg class="ZDI--CloudCheck24"></svg></div>' : ''}
    <button type="button">保存草稿并离开</button><button type="button">${mode === 'edit' ? '提交修改' : '发布回答'}</button></form>${extra}`;
}
function dom(html, path = url) { return new JSDOM(html, { url: path, runScripts: 'outside-only', pretendToBeVisual: true }); }
function run(instance, fn, ...args) {
    return instance.window.eval(`(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(',')})`);
}

describe('draft options and content policy', () => {
    it.each([id, `question:${id}`, `${url}#write`])('accepts question target %s without losing precision', target => {
        expect(resolveDraftOptions({ target })).toMatchObject({ questionId: id, url, mode: 'auto', existing: 'error', timeout: 30, closeEditor: true });
    });
    it('accepts an answer target for edit drafts', () => {
        expect(resolveDraftOptions({ target: `answer:${id}:123`, mode: 'edit' })).toMatchObject({ questionId: id, url: `${url}/answer/123` });
    });
    it.each([
        { mode: 'bad' }, { existing: 'bad' }, { timeout: 0 }, { timeout: 121 }, { timeout: 1.5 },
        { 'close-editor': 'maybe' }, { mode: 'new', target: `answer:${id}:123` },
        { target: 'article:123' }, { target: 'https://example.com/question/123' },
        { 'dry-run': true, execute: true },
    ])('rejects invalid options %j', options => {
        expect(() => resolveDraftOptions({ target: id, ...options })).toThrow();
    });
    it('parses CLI boolean strings correctly', () => {
        expect(resolveDraftOptions({ target: id, 'close-editor': 'false', 'dry-run': 'false' })).toMatchObject({ closeEditor: false, dryRun: false });
    });
    it('protects existing content but treats identical text as a no-op', () => {
        expect(() => planDraftContent('原文', '新文', 'error', '\n\n')).toThrow();
        expect(planDraftContent('原文', '原文', 'error', '\n\n')).toMatchObject({ changed: false, expected: '原文' });
    });
    it('preserves image-only drafts during append and prepend', () => {
        expect(planDraftContent('', '新文', 'append', '\n\n', true)).toMatchObject({ position: 'append', insertion: '新文', expected: '新文' });
        expect(planDraftContent('', '新文', 'prepend', '\n\n', true)).toMatchObject({ position: 'prepend', insertion: '新文' });
    });
    it.each([
        ['replace', '新文', '新文'], ['append', '原文\n\n新文', '\n\n新文'], ['prepend', '新文\n\n原文', '新文\n\n'],
    ])('supports %s', (policy, expected, insertion) => {
        expect(planDraftContent('原文', '新文', policy, '\n\n')).toMatchObject({ changed: true, expected, insertion });
    });
});

describe('draft DOM handling', () => {
    it('reads multiline content and distinguishes new/edit modes and saved state', () => {
        for (const mode of ['new', 'edit']) {
            const d = dom(fixture({ text: '第一段\n\n第二段', mode, saved: true }));
            expect(run(d, inspectDraftPage, id)).toMatchObject({ status: 'editor', mode, text: '第一段\n\n第二段', saved: true, title: '测试问题' });
            d.window.close();
        }
    });
    it('rejects a wrong question or login page', () => {
        const wrong = dom(fixture(), 'https://www.zhihu.com/question/999');
        expect(run(wrong, inspectDraftPage, id).status).toBe('wrong_target');
        wrong.window.close();
        const login = dom('', 'https://www.zhihu.com/signin');
        expect(run(login, inspectDraftPage, id).status).toBe('auth');
        login.window.close();
    });
    it('detects a deleted own answer without restoring it', () => {
        const d = dom('<h1>测试问题</h1><button>撤销删除</button>');
        expect(run(d, inspectDraftPage, id).status).toBe('deleted');
        expect(run(d, clickDraftControl, id, 'open')).toBe(false);
        d.window.close();
    });
    it('resolves only the current question’s own-answer link', () => {
        const d = dom(`<h1>测试问题</h1><a href="${url}/answer/123">查看我的回答</a><a href="https://example.com/question/${id}/answer/999">查看我的回答</a>`);
        expect(run(d, inspectDraftPage, id).ownAnswerUrl).toBe(`${url}/answer/123`);
        d.window.close();
    });
    it('ignores comment editors and hidden answer editors', () => {
        const d = dom('<div contenteditable="true" role="textbox">comment</div><form class="AnswerForm" hidden><div contenteditable="true">hidden draft</div></form>');
        expect(run(d, inspectDraftPage, id).status).toBe('page');
        d.window.close();
    });
    it('fails closed for ambiguous answer editors', () => {
        const d = dom(fixture() + fixture());
        expect(run(d, inspectDraftPage, id).status).toBe('ambiguous');
        d.window.close();
    });
    it('only clicks the exact draft-save button, never publish or submit', () => {
        const d = dom(fixture());
        const clicked = [];
        d.window.document.querySelectorAll('button').forEach(b => b.addEventListener('click', e => { e.preventDefault(); clicked.push(b.textContent); }));
        expect(run(d, clickDraftControl, id, 'save')).toBe(true);
        expect(clicked).toEqual(['保存草稿并离开']);
        expect(run(d, clickDraftControl, id, 'publish')).toBe(false);
        d.window.close();
    });
    it('checks content again before selecting, without replacing rich markup', () => {
        const d = dom(fixture({ text: '<strong>原文</strong>' }));
        expect(run(d, prepareDraftInsertion, id, '原文', 'append')).toMatchObject({ ok: true });
        expect(d.window.getSelection().isCollapsed).toBe(true);
        expect(d.window.document.querySelector('strong').textContent).toBe('原文');
        expect(run(d, prepareDraftInsertion, id, '过期正文', 'replace')).toMatchObject({ ok: false, reason: 'content_changed' });
        d.window.close();
    });
});

// Synthetic contract for the observed new publisher portal, not a live snapshot.
describe('new answer action bar outside the form', () => {
    it('finds only the action bar associated with the unique answer form', () => {
        const html = `<div id="AnswerFormPortalContainer"><div id="js-answerAddCard"><form class="AnswerForm"><div class="public-DraftEditor-content" contenteditable="true">正文</div></form><div><div class="DraftStatusTip">刚刚 · 草稿<svg class="ZDI--CloudCheck24"></svg></div><button>保存草稿并离开</button><button>发布回答</button></div></div></div><button>提交修改</button>`;
        const d = dom(html);
        expect(run(d, inspectDraftPage, id)).toMatchObject({ status: 'editor', mode: 'new', saved: true, text: '正文' });
        let clicked = 0; d.window.document.querySelector('#js-answerAddCard button').onclick = () => clicked++;
        expect(run(d, clickDraftControl, id, 'save')).toBe(true); expect(clicked).toBe(1);
        d.window.close();
    });
    it('does not borrow a publish button outside the answer container', () => {
        const d = dom('<form class="AnswerForm"><div class="public-DraftEditor-content" contenteditable="true"></div></form><button>发布回答</button>');
        expect(run(d, inspectDraftPage, id).status).toBe('page');
        d.window.close();
    });
});
