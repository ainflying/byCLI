import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { fetchTotalData, fetchPosts, fetchPostDetail, fetchPostMetrics } from './client.js';

const HOST = 'https://channels.weixin.qq.com';
const PREFIX = `${HOST}/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/`;
const RANGE = { startDate: '2026-10-06', endDate: '2026-10-12', days: 7, startTs: 1791216000, endTs: 1791734400 };
const TEMPLATE = { startTs: '1791648000', endTs: '1791734400', interval: 3, timestamp: '1791872254942', rawKeyBuff: 'test-credential', pluginSessionId: 'test-session', scene: 7, reqScene: 7 };
function capture(overrides = {}) {
  return { url: `${PREFIX}new_post_total_data?_rid=example`, responseStatus: 201,
    requestBodyPreview: JSON.stringify(TEMPLATE), responsePreview: JSON.stringify({ errCode: 0, data: { totalData: {} } }), ...overrides };
}
function browser(server, options = {}) {
  const dom = new JSDOM(`<iframe src="${HOST}/empty.html"></iframe>`, { url: `${HOST}/platform/statistic/post`, runScripts: 'outside-only' });
  const win = dom.window.document.querySelector('iframe').contentWindow;
  const requests = [], events = [];
  win.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url, opts, body });
    // Reject requests that would fail against the authenticated real service.
    const validAuth = options.allowEmptyAuth
      ? body.rawKeyBuff === '' && body.pluginSessionId === null
      : body.rawKeyBuff === 'test-credential' && body.pluginSessionId === 'test-session';
    if (!validAuth || opts.credentials !== 'include') {
      return { status: 403, json: async () => ({ errCode: 403 }) };
    }
    const reply = await server(new URL(url).pathname.split('/').at(-1), body);
    return { status: reply.status ?? 201, json: async () => reply.body ?? { errCode: 0, data: reply.data } };
  };
  let reads = 0;
  let suppressed = false;
  const page = {
    startNetworkCapture: async () => { events.push('capture'); return options.supported ?? true; },
    goto: async url => { events.push('navigate'); suppressed = options.existingPage && url === `${HOST}/platform/statistic/post`; if (options.login) dom.reconfigure({ url: `${HOST}/login` }); },
    readNetworkCapture: async () => !suppressed && ++reads === 1 ? options.captures ?? [capture()] : [],
    wait: async () => {},
    evaluate: async (code) => dom.window.eval(code),
  };
  return { page, requests, events, close: () => dom.window.close() };
}

describe('video channel browser API client', () => {
  it('replays a fresh authenticated request in the statistics iframe and accepts HTTP 201', async () => {
    const b = browser((name, body) => ({ data: { totalData: { browse: ['1', '4', '1', '13', '7', '0', '2'] } } }));
    try {
      expect(await fetchTotalData(b.page, RANGE)).toEqual({ totalData: { browse: ['1', '4', '1', '13', '7', '0', '2'] } });
      expect(b.events.indexOf('capture')).toBeLessThan(b.events.indexOf('navigate'));
      expect(b.requests[0].body).toMatchObject({ startTs: '1791216000', endTs: '1791734400', interval: 3 });
      expect(b.requests[0].url).toBe(`${PREFIX}new_post_total_data`);
    } finally { b.close(); }
  });
  it('ignores lookalike domains while selecting the session template', async () => {
    const b = browser(() => ({ data: { totalData: {} } }), { captures: [capture({ url: 'https://example.invalid/statistic/new_post_total_data', requestBodyPreview: '{"rawKeyBuff":"evil"}' }), capture()] });
    try { expect(await fetchTotalData(b.page, RANGE)).toEqual({ totalData: {} }); } finally { b.close(); }
  });
  it('uses a captured request before its response arrives because capture reads drain pending entries', async () => {
    const b = browser(() => ({ data: { totalData: { browse: ['2'] } } }), {
      captures: [capture({ responsePreview: undefined, responseStatus: undefined })],
    });
    try { expect(await fetchTotalData(b.page, RANGE)).toEqual({ totalData: { browse: ['2'] } }); } finally { b.close(); }
  });
  it('triggers a fresh navigation when the statistics tab was retained by a previous command', async () => {
    const b = browser(() => ({ data: { totalData: { browse: ['2'] } } }), { existingPage: true });
    try { expect(await fetchTotalData(b.page, RANGE)).toEqual({ totalData: { browse: ['2'] } }); } finally { b.close(); }
  });
  it('preserves empty key and null session fields used by a valid cookie-authenticated session', async () => {
    const b = browser(() => ({ data: { totalData: { browse: ['2'] } } }), {
      allowEmptyAuth: true,
      captures: [capture({ requestBodyPreview: JSON.stringify({ ...TEMPLATE, rawKeyBuff: '', pluginSessionId: null }) })],
    });
    try { expect(await fetchTotalData(b.page, RANGE)).toEqual({ totalData: { browse: ['2'] } }); } finally { b.close(); }
  });
  it('requires network request capture instead of silently using unauthenticated fetch', async () => {
    const b = browser(() => ({ data: {} }), { supported: false });
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(CommandExecutionError); expect(b.requests).toHaveLength(0); } finally { b.close(); }
  });
  it('reports a missing bootstrap response as a timeout', async () => {
    const b = browser(() => ({ data: {} }), { captures: [] });
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(TimeoutError); } finally { b.close(); }
  });
  it('reports a login redirect with the authenticated-domain error', async () => {
    const b = browser(() => ({ data: {} }), { captures: [], login: true });
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(AuthRequiredError); } finally { b.close(); }
  });
  it.each([401, 403])('reports HTTP %s as an authentication failure', async status => {
    const b = browser(() => ({ status, body: { errCode: status } }));
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(AuthRequiredError); } finally { b.close(); }
  });
  it('rejects a business error even when its HTTP request succeeded', async () => {
    const b = browser(() => ({ body: { errCode: 12345, errMsg: 'test-credential test-session', data: {} } }));
    try {
      const error = await fetchTotalData(b.page, RANGE).catch(e => e);
      expect(error).toBeInstanceOf(CommandExecutionError);
      expect(error.message).not.toContain('test-credential');
      expect(error.message).not.toContain('test-session');
    } finally { b.close(); }
  });
  it('rejects malformed JSON API envelopes', async () => {
    const b = browser(() => ({ body: { data: {} } }));
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(CommandExecutionError); } finally { b.close(); }
  });
  it('rejects partial bootstrap request bodies', async () => {
    const b = browser(() => ({ data: {} }), { captures: [capture({ requestBodyTruncated: true })] });
    try { await expect(fetchTotalData(b.page, RANGE)).rejects.toBeInstanceOf(CommandExecutionError); } finally { b.close(); }
  });
  it('returns a legitimate empty video list', async () => {
    const b = browser(() => ({ data: { list: [], totalCount: 0 } }));
    try { expect(await fetchPosts(b.page, RANGE, 20)).toEqual([]); } finally { b.close(); }
  });
  it('fetches successive pages and applies the requested limit without losing ids', async () => {
    const b = browser((name, body) => ({ data: { totalCount: 23, list: Array.from({ length: body.currentPage === 3 ? 3 : 10 }, (_, i) => ({ objectId: String((body.currentPage - 1) * 10 + i + 1), createTime: RANGE.startTs })) } }));
    try {
      const rows = await fetchPosts(b.page, RANGE, 22);
      expect(rows.map(r => r.objectId)).toEqual(Array.from({ length: 22 }, (_, i) => String(i + 1)));
      expect(b.requests.map(r => r.body.currentPage)).toEqual([1, 2, 3]);
      expect(b.requests[0].body).toMatchObject({ startTime: 1791216000, endTime: 1791820800, pageSize: 10 });
    } finally { b.close(); }
  });
  it('refuses to return partial results when pagination repeats a page', async () => {
    const b = browser(() => ({ data: { totalCount: 20, list: Array.from({ length: 10 }, (_, i) => ({ objectId: String(i + 1), createTime: RANGE.startTs })) } }));
    try { await expect(fetchPosts(b.page, RANGE, 20)).rejects.toBeInstanceOf(CommandExecutionError); } finally { b.close(); }
  });
  it('filters publication dates locally and scans later pages before applying the matching limit', async () => {
    const b = browser((name, body) => ({ data: { totalCount: 20, list: Array.from({ length: 10 }, (_, i) => ({
      objectId: String((body.currentPage - 1) * 10 + i + 1), createTime: body.currentPage === 1 ? RANGE.endTs + 86400 : RANGE.startTs,
    })) } }));
    try {
      expect((await fetchPosts(b.page, RANGE, 2)).map(p => p.objectId)).toEqual(['11', '12']);
      expect(b.requests).toHaveLength(2);
    } finally { b.close(); }
  });
  it('returns an empty date-filtered list when only out-of-window works exist', async () => {
    const b = browser(() => ({ data: { totalCount: 1, list: [{ objectId: '1', createTime: RANGE.endTs + 86400 }] } }));
    try { expect(await fetchPosts(b.page, RANGE, 20)).toEqual([]); } finally { b.close(); }
  });
  it('looks up exact current-video identity independently of settlement dates', async () => {
    const id = '15035867620425145936';
    const b = browser(() => ({ data: { totalCount: 1, list: [{ objectId: id, createTime: RANGE.endTs + 86400 }] } }));
    try { expect((await fetchPostMetrics(b.page, id)).objectId).toBe(id); } finally { b.close(); }
  });
  it('does not manufacture current-video metrics when the exact ID is absent', async () => {
    const b = browser(() => ({ data: { totalCount: 0, list: [] } }));
    try { await expect(fetchPostMetrics(b.page, '999')).rejects.toMatchObject({ code: 'EMPTY_RESULT' }); } finally { b.close(); }
  });
  it('refuses a prematurely empty page', async () => {
    const b = browser((name, body) => ({ data: { totalCount: 20, list: body.currentPage === 1 ? [{ objectId: '1', createTime: RANGE.startTs }] : [] } }));
    try { await expect(fetchPosts(b.page, RANGE, 20)).rejects.toBeInstanceOf(CommandExecutionError); } finally { b.close(); }
  });
  it.each([0, -1, 1.5, Infinity, 1001])('rejects invalid or excessive list limit %s before browser access', async limit => {
    const b = browser(() => ({ data: {} }));
    try { await expect(fetchPosts(b.page, RANGE, limit)).rejects.toBeInstanceOf(ArgumentError); expect(b.events).toEqual([]); } finally { b.close(); }
  });
  it('uses feedId unchanged for trend and retention queries', async () => {
    const b = browser(name => ({ data: name === 'get_feed_lost_rate' ? { items: [{ sec: 0, rate: 1 }], videoLen: 10, maxLostRateSec: 0 } : { feedData: [{ totalData: {} }] } }));
    try {
      expect(await fetchPostDetail(b.page, '18446744073709551615', RANGE)).toEqual({ data: { feedData: [{ totalData: {} }] }, retention: { items: [{ sec: 0, rate: 1 }], videoLen: 10, maxLostRateSec: 0 } });
      expect(b.requests.map(r => r.body.feedId)).toEqual(['18446744073709551615', '18446744073709551615']);
      expect(b.requests[0].body).toMatchObject({ startTs: '1791216000', endTs: '1791734400', interval: 3 });
    } finally { b.close(); }
  });
  it.each(['', 'abc', '1/../auth', 123])('rejects an invalid video id %s before browser access', async id => {
    const b = browser(() => ({ data: {} }));
    try { await expect(fetchPostDetail(b.page, id, RANGE)).rejects.toBeInstanceOf(ArgumentError); expect(b.events).toEqual([]); } finally { b.close(); }
  });
});
