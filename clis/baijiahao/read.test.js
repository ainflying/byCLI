import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { exactId, backendId, count, statisticsRange, publicTarget, normalizeStatistics, statsColumns } from './_shared/model.js';
import { bootstrap, request, readStatistics, managementPost } from './_shared/client.js';
import { publicVideoDOM } from './_shared/download.js';
import { videoStatsCommand } from './video-stats.js';
import { articleStatsCommand } from './article-stats.js';
import { imageTextStatsCommand } from './image-text-stats.js';

const ID = '1879458669366991738', NID = '6134461117009265959';
const work = { id: ID, nid: NID, title: '验收视频', status: 'publish', publishedAt: '2026-10-19 22:21:19' };
const raw = { id: ID, nid: NID, article_id: NID, title: work.title, type: 'video', status: 'publish', view_count: '0', likes_count: 0, comment_count: '0', collect_count: '--', share_count: undefined };
const range = { start: '2026-10-19', end: '2026-10-19' };
function browser(server, url = 'https://baijiahao.baidu.com/builder/rc/content') {
  const dom = new JSDOM('', { url, runScripts: 'outside-only' }), calls = [];
  dom.window.fetch = async (path, options) => { calls.push({ path, options }); const reply = server(path); return { status: reply.status ?? 200, json: async () => reply.body ?? { errno: 0, data: reply } }; };
  return { page: { evaluate: async code => dom.window.eval(code), goto: async url => dom.reconfigure({ url }) }, calls, close: () => dom.window.close() };
}
describe('Baijiahao identities and metrics', () => {
  it('renews an expired read lease after a long upload without treating other failures as navigation requests', async () => {
    const urls = [], stale = { evaluate: async () => { throw new Error('Page not found: stale page identity'); }, goto: async url => urls.push(url) };
    await bootstrap(stale); expect(urls).toEqual(['https://baijiahao.baidu.com/builder/rc/content']);
    const denied = { evaluate: async () => { throw new Error('policy denied'); }, goto: async url => urls.push(url) };
    await expect(bootstrap(denied)).rejects.toThrow('policy denied'); expect(urls).toHaveLength(1);
  });
  it('keeps 64-bit identities exact and rejects rounded numeric IDs', () => {
    expect(exactId(ID)).toBe(ID); expect(backendId(NID, 'nid')).toBe(NID);
    expect(() => exactId(Number(ID))).toThrow(); expect(() => backendId(Number(ID), 'id')).toThrow();
  });
  it('retains zero separately from unavailable counters and preserves column order', () => {
    const row = normalizeStatistics(raw, work, 'video', range, 'sample');
    expect(Object.keys(row)).toEqual(statsColumns('video'));
    expect(row).toMatchObject({ plays: 0, likes: 0, comments: 0, collections: null, shares: null, unavailableMetrics: { collections: 'not_returned', shares: 'not_returned' } });
    expect(() => count('1.2万', 'views')).toThrow(); expect(() => count(-1, 'views')).toThrow();
  });
  it.each([{ id: '123' }, { nid: '123' }, { article_id: '123' }, { type: 'news' }, { status: 'draft' }, { title: 'other' }])('rejects mismatched work identity %j', change => {
    expect(() => normalizeStatistics({ ...raw, ...change }, work, 'video', range)).toThrow();
  });
  it('validates paired real calendar dates without silently adjusting them', () => {
    const now = new Date('2026-10-19T15:00:00Z');
    expect(statisticsRange({}, '2026-10-19', now)).toEqual(range);
    for (const args of [{ 'start-date': '2026-10-19' }, { 'start-date': '2026-02-30', 'end-date': '2026-10-19' }, { 'start-date': '2026-10-20', 'end-date': '2026-10-20' }]) expect(() => statisticsRange(args, undefined, now)).toThrow();
  });
  it('registers separate business commands while sharing the news driver', () => {
    expect([videoStatsCommand.name, articleStatsCommand.name, imageTextStatsCommand.name]).toEqual(['video-stats', 'article-stats', 'image-text-stats']);
    expect(articleStatsCommand.columns).toEqual(imageTextStatsCommand.columns);
  });
  it('executes the actual in-page read script with credentialed GET and exact ID reconciliation', async () => {
    const b = browser(path => path.startsWith('/pcui/') ? { list: [{ article_id: ID, nid: NID, title: work.title, type: 'video', status: 'publish', publish_at: work.publishedAt }], page: { totalCount: 1 } } : { list: [raw], count: '1' });
    try {
      expect((await readStatistics(b.page, { id: ID }, 'video'))[0].plays).toBe(0);
      expect(b.calls).toHaveLength(2); expect(b.calls[0].options).toMatchObject({ credentials: 'include', cache: 'no-store' });
      expect(b.calls[1].path).toContain('start_day=20261019');
    } finally { b.close(); }
  });
  it('does not manufacture an empty statistics row', async () => {
    const b = browser(() => ({ list: [], page: { totalCount: 0 } }));
    try { await expect(managementPost(b.page, ID, 'video')).rejects.toMatchObject({ code: 'EMPTY_RESULT' }); } finally { b.close(); }
  });
  it('rejects a duplicate matching management item before returning it', async () => {
    const item = { article_id: ID, nid: NID, title: work.title, type: 'video', status: 'publish' };
    const b = browser(() => ({ list: [item, item], page: { totalCount: 2 } }));
    try { await expect(managementPost(b.page, ID, 'video')).rejects.toThrow(/repeated/); } finally { b.close(); }
  });
  it('detects a login route without issuing a backend request', async () => {
    const b = browser(() => ({}), 'https://baijiahao.baidu.com/builder/theme/bjh/login');
    try { await expect(request(b.page, '/builder/app/appinfo')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(b.calls).toHaveLength(0); } finally { b.close(); }
  });
  it('uses the token from an exact native management GET only for the draft read', async () => {
    const b = browser(() => ({ article: { id: ID } }));
    b.page.startNetworkCapture = async () => true;
    b.page.readNetworkCapture = async () => [
      { method: 'GET', url: 'https://evil.invalid/pcui/article/lists', requestHeaders: { token: 'wrong' } },
      { method: 'GET', url: 'https://baijiahao.baidu.com/pcui/article/lists?currentPage=1', requestHeaders: { token: 'native-test-token' } },
    ];
    try {
      expect(await request(b.page, `/pcui/article/edit?type=video&article_id=${ID}`)).toEqual({ article: { id: ID } });
      expect(b.calls[0].options.headers).toEqual({ token: 'native-test-token' });
      expect(b.calls[0].options.method).toBeUndefined();
    } finally { b.close(); }
  });
  it('reports an expired Baijiahao authenticated read without exposing server text', async () => {
    const b = browser(() => ({ body: { errno: 10000013, errmsg: 'private server text' } }));
    try { await expect(request(b.page, '/builder/app/appinfo')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); } finally { b.close(); }
  });
});
describe('Baijiahao public download boundary', () => {
  it('supports other-account public distribution links and rejects draft previews/lookalike hosts', () => {
    expect(publicTarget('https://haokan.baidu.com/v?vid=3119638018416685313&collection_id=')).toMatchObject({ id: '3119638018416685313', source: 'haokan-video' });
    for (const value of ['https://baijiahao.baidu.com/builder/preview/s?id=123', 'https://haokan.baidu.com.evil/v?vid=123', 'https://user@haokan.baidu.com/v?vid=123']) expect(() => publicTarget(value)).toThrow();
  });
  it('deduplicates identical video nodes and retains ambiguity for the downloader to reject', () => {
    const dom = new JSDOM('<video src="https://v.bdstatic.com/a.mp4"></video><video></video><video src="https://v.bdstatic.com/a.mp4"></video>', { url: 'https://haokan.baidu.com/v?vid=123', runScripts: 'outside-only' });
    try {
      expect(dom.window.eval(`(${publicVideoDOM})()`).media).toHaveLength(1);
      dom.window.document.querySelectorAll('video')[1].src = 'https://v.bdstatic.com/b.mp4';
      expect(dom.window.eval(`(${publicVideoDOM})()`).media).toHaveLength(2);
    } finally { dom.window.close(); }
  });
  it('extracts the actual two-player Haokan fixture without treating its empty player as another video', () => {
    const html = readFileSync(new URL('./__fixtures__/public-video.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://haokan.baidu.com/v?vid=3119638018416685313', runScripts: 'outside-only' });
    try { expect(dom.window.eval(`(${publicVideoDOM})()`).media).toHaveLength(1); } finally { dom.window.close(); }
  });
});
