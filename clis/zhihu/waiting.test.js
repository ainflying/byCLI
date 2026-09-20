import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@sovovs/bycli/registry';
import { readWaitingPage } from './waiting.js';

const id = '2083490043117691170';
const card = (questionId = id, title = '机器人可以取代人类吗？') => `
<div class="jsNavigable"><div><div><div>你可能感兴趣</div>
<a href="https://www.zhihu.com/question/${questionId}">${title}</a>
<div>11,459 浏览 · 985 回答 · 1,012 关注 · 4 天前的提问</div>
</div><div><a type="button">写回答</a></div></div></div>`;
function read(html, path = '/question/waiting', expectedLabel) {
    const dom = new JSDOM(html, { url: `https://www.zhihu.com${path}`, runScripts: 'outside-only' });
    try { return dom.window.eval(`(${readWaitingPage.toString()})(${JSON.stringify(expectedLabel)})`); }
    finally { dom.window.close(); }
}
const list = html => `<div class="QuestionWaiting-questions" role="list">${html}</div>`;
function pageWith(...states) {
    let index = 0;
    return {
        goto: vi.fn(), wait: vi.fn(), scroll: vi.fn(),
        evaluate: vi.fn(async () => states[Math.min(index++, states.length - 1)]),
    };
}
const cmd = () => getRegistry().get('zhihu/waiting');

describe('zhihu waiting page extraction', () => {
    it('reads real card structure, preserves long IDs and excludes unrelated links', () => {
        const result = read(`<a href="/question/999">sidebar</a>${list(card())}`);
        expect(result.items).toEqual([{
            id, title: '机器人可以取代人类吗？', views: 11459, answers: 985, followers: 1012,
            url: `https://www.zhihu.com/question/${id}`,
        }]);
    });
    it('keeps zero counts and does not invent missing counts', () => {
        const html = card().replace('11,459 浏览 · 985 回答 · 1,012 关注', '0 回答');
        expect(read(list(html)).items[0]).toMatchObject({ views: null, answers: 0, followers: null });
    });
    it('removes title badges and expands displayed compact counts', () => {
        const html = card(id, '<div>新问</div>真实标题').replace('11,459 浏览', '1.2万 浏览');
        expect(read(list(html)).items[0]).toMatchObject({ title: '真实标题', views: 12000 });
    });
    it('ignores answer links and foreign-domain question links', () => {
        expect(read(list(card().replace('www.zhihu.com', 'example.com'))).items).toEqual([]);
        expect(read(list(card().replace(`/question/${id}`, `/question/${id}/answer/123`))).items).toEqual([]);
    });
    it('distinguishes login, verification, missing layout and an empty list', () => {
        expect(read('', '/signin?next=%2Fquestion%2Fwaiting').status).toBe('auth');
        expect(read('', '/account/unhuman').status).toBe('auth');
        expect(read('<main>unrecognized page</main>').status).toBe('missing');
        expect(read(list(''))).toMatchObject({ status: 'ready', items: [] });
    });
});

describe('zhihu waiting command', () => {
    it('registers read-only and returns ranked questions in page order', async () => {
        const page = pageWith(read(list(card() + card('123', '第二个问题'))));
        expect(cmd()).toMatchObject({ access: 'read', strategy: 'cookie' });
        const rows = await cmd().func(page, { limit: 1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ rank: 1, id });
        expect(page.goto).toHaveBeenCalledWith('https://www.zhihu.com/question/waiting');
        expect(page.scroll).not.toHaveBeenCalled();
    });
    it('scrolls for more questions and deduplicates by ID', async () => {
        const page = pageWith(read(list(card())), read(list(card())), read(list(card() + card('123', '第二个问题'))));
        expect((await cmd().func(page, { limit: 2 })).map(row => row.id)).toEqual([id, '123']);
        expect(page.scroll).toHaveBeenCalled();
    });
    it('stops after repeated no-growth responses, including an empty list', async () => {
        for (const html of ['', card()]) {
            const page = pageWith(read(list(html)));
            const rows = await cmd().func(page, { limit: 20 });
            expect(rows).toHaveLength(html ? 1 : 0);
            expect(page.evaluate.mock.calls.length).toBeLessThanOrEqual(5);
        }
    });
    it.each([0, -1, 1.5, 1001, 'bad'])('rejects invalid limit %s before navigation', async limit => {
        const page = pageWith();
        await expect(cmd().func(page, { limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('reports login instead of an empty result', async () => {
        await expect(cmd().func(pageWith({ status: 'auth' }), {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });
    it('waits for initial rendering, then reports a missing layout', async () => {
        const page = pageWith({ status: 'missing' }, read(list(card())));
        expect(await cmd().func(page, { limit: 1 })).toHaveLength(1);
        await expect(cmd().func(pageWith({ status: 'missing' }), {})).rejects.toMatchObject({ code: 'DOM_CHANGED' });
    });
});


describe('zhihu waiting categories', () => {
    it.each([
        ['recommend', '', '为你推荐'],
        ['invited', '?type=invite', '邀请回答'],
        ['latest', '?type=new', '最新问题'],
        ['hot', '?type=hot', '人气问题'],
    ])('opens and checks the %s category', async (type, query, label) => {
        const page = pageWith(read(list(card())));
        await cmd().func(page, { type, limit: 1 });
        expect(page.goto).toHaveBeenCalledWith(`https://www.zhihu.com/question/waiting${query}`);
        expect(page.evaluate.mock.calls[0][0]).toContain(JSON.stringify(label));
    });
    it.each(['unknown', 'new', '', 'toString'])('rejects invalid type %s before navigation', async type => {
        const page = pageWith();
        await expect(cmd().func(page, { type })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('does not accept a list from the wrong or not-yet-rendered category', () => {
        const tabs = '<a role="tab" aria-selected="true">为你推荐</a><a role="tab" aria-selected="false">最新问题</a>';
        expect(read(tabs + list(card()), '/question/waiting?type=new', '最新问题').status).toBe('missing');
        expect(read(list(card()), '/question/waiting?type=new', '最新问题').status).toBe('missing');
        expect(read(tabs.replace('为你推荐', '最新问题') + list(card()), '/question/waiting?type=new', '最新问题').items).toHaveLength(1);
    });
    it('reads invitation counts without inventing views', () => {
        const html = card().replace('11,459 浏览 · 985 回答 · 1,012 关注 · 4 天前的提问', '1.7 万回答 · 1.7 万关注');
        expect(read(list(html), '/question/waiting?type=invite').items[0]).toMatchObject({ views: null, answers: 17000, followers: 17000 });
    });
});
