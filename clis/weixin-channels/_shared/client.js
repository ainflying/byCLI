import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from '@sovovs/bycli/errors';
import { randomUUID } from 'node:crypto';

const DOMAIN = 'channels.weixin.qq.com';
const PAGE_URL = `https://${DOMAIN}/platform/statistic/post`;
const API_PREFIX = `/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/`;
const POLL_ATTEMPTS = 40;
const POLL_SECONDS = 0.25;
const AUTH_FIELDS = ['timestamp', '_log_finder_uin', '_log_finder_id', 'rawKeyBuff', 'pluginSessionId', 'scene', 'reqScene'];

function requireData(status, body, endpoint) {
  if (status === 401 || status === 403 || body?.errCode === 401 || body?.errCode === 403
    || (body?.errCode !== 0 && /登录|not.?logged|login|session.*expired/i.test(String(body?.errMsg ?? '')))) {
    throw new AuthRequiredError(DOMAIN);
  }
  // The service returns HTTP 201 for successful read-only queries.
  if (!Number.isInteger(status) || status < 200 || status >= 300 || !body || body.errCode !== 0
    || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new CommandExecutionError(`weixin-channels ${endpoint}: invalid API response (HTTP ${Number(status) || 0}, code ${Number(body?.errCode) || 0})`);
  }
  return body.data;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function isLoginPage(page) {
  return await page.evaluate(`(() => {
    return /\\/login(?:\\/|$)/i.test(window.location.pathname)
      || /扫码登录|扫描二维码登录|登录视频号助手|Log in/i.test(document.body?.innerText || '');
  })()`);
}

/** Capture a fresh page request. Credentials are never returned by public helpers. */
async function bootstrap(page) {
  if (typeof page?.startNetworkCapture !== 'function' || typeof page?.readNetworkCapture !== 'function') {
    throw new CommandExecutionError('weixin-channels requires Browser Bridge network capture', 'Update the byCLI browser extension and log in to 视频号助手.');
  }
  if (await page.startNetworkCapture('/statistic/') === false) {
    throw new CommandExecutionError('weixin-channels network capture is unavailable', 'Update the byCLI browser extension.');
  }
  // A retained tab already at PAGE_URL hits the bridge's no-navigation fast
  // path. A harmless query nonce guarantees a guarded, fresh page request.
  await page.goto(`${PAGE_URL}?bycli_capture=${randomUUID()}`, { stealth: false });
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const captures = await page.readNetworkCapture();
    for (const entry of captures) {
      let url;
      try { url = new URL(entry.url); } catch { continue; }
      if (url.protocol !== 'https:' || url.hostname !== DOMAIN || url.pathname !== `${API_PREFIX}new_post_total_data`) continue;
      if (entry.requestBodyTruncated || entry.responseBodyTruncated) {
        throw new CommandExecutionError('weixin-channels bootstrap capture was truncated');
      }
      // Capture reads drain pending requests too. The complete request body is
      // enough to bootstrap; our own API response will verify the session.
      if (entry.responsePreview) requireData(entry.responseStatus, parseObject(entry.responsePreview), 'session');
      const request = parseObject(entry.requestBodyPreview);
      // Cookie-authenticated sessions legitimately send an empty rawKeyBuff
      // and a null pluginSessionId. Preserve the template without inventing auth.
      if (!request || typeof request.rawKeyBuff !== 'string') {
        throw new CommandExecutionError('weixin-channels session request is unavailable', 'Reload 视频号助手 and retry.');
      }
      return Object.fromEntries(AUTH_FIELDS.filter(key => key in request).map(key => [key, request[key]]));
    }
    if (await isLoginPage(page)) throw new AuthRequiredError(DOMAIN);
    await page.wait(POLL_SECONDS);
  }
  throw new TimeoutError('weixin-channels session capture', POLL_ATTEMPTS * POLL_SECONDS, 'Open 视频号助手 in Chrome, finish login, and retry.');
}

async function request(page, auth, endpoint, params) {
  const url = `https://${DOMAIN}${API_PREFIX}${endpoint}`;
  const body = JSON.stringify({ ...auth, ...params, timestamp: String(Date.now()) });
  // The statistic app is a same-origin iframe. Use its fetch implementation and
  // referrer, while keeping credentials and raw session fields inside the browser.
  let response;
  try {
    response = await page.evaluate(`(async () => {
      if (window.location.hostname !== ${JSON.stringify(DOMAIN)}) return { status: 401 };
      const frame = document.querySelector('iframe');
      const context = frame?.contentWindow || window;
      if (context.location.hostname !== ${JSON.stringify(DOMAIN)}) return { status: 401 };
      try {
        const response = await context.fetch(${JSON.stringify(url)}, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: ${JSON.stringify(body)},
        });
        let parsed;
        try { parsed = await response.json(); } catch { return { status: response.status }; }
        return { status: response.status, body: parsed };
      } catch { return { status: 0 }; }
    })()`);
  } catch {
    // Transport exceptions may include the script (and session fields).
    throw new CommandExecutionError(`weixin-channels ${endpoint}: browser request failed`, 'Reload 视频号助手 and retry.');
  }
  return requireData(response?.status, response?.body, endpoint);
}

function periodParams(range) {
  return { startTs: String(range.startTs), endTs: String(range.endTs), interval: 3 };
}

export async function fetchTotalData(page, range) {
  const auth = await bootstrap(page);
  return request(page, auth, 'new_post_total_data', periodParams(range));
}

async function readPostList(page, range, limit = 20, targetId = null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ArgumentError('--limit must be an integer between 1 and 1000');
  }
  const auth = await bootstrap(page);
  const rows = [], seen = new Set();
  let expected;
  // The live service may ignore publication-date filters. Scan full pages and
  // apply that filter locally; --limit counts matching works, not scanned rows.
  for (let currentPage = 1; currentPage <= 100; currentPage += 1) {
    const data = await request(page, auth, 'post_list', {
      pageSize: 10, currentPage, sort: 0, order: 0,
      startTime: range.startTs, endTime: range.endTs + 86400,
    });
    if (!Array.isArray(data.list) || !Number.isSafeInteger(data.totalCount) || data.totalCount < 0) {
      throw new CommandExecutionError('weixin-channels post_list: unexpected list response');
    }
    if (expected === undefined) expected = data.totalCount;
    if (expected === 0 && data.list.length === 0) return [];
    const before = seen.size;
    for (const row of data.list) {
      if (typeof row?.objectId !== 'string' || !/^\d+$/.test(row.objectId)) {
        throw new CommandExecutionError('weixin-channels post_list: video id is unavailable');
      }
      if (!seen.has(row.objectId)) {
        seen.add(row.objectId);
        if (targetId) { if (row.objectId === targetId) return [row]; continue; }
        const time = row.createTime;
        if (!(typeof time === 'number' || typeof time === 'string' && /^\d+$/.test(time)) || !Number.isSafeInteger(Number(time)) || Number(time) < 0) throw new CommandExecutionError('weixin-channels post_list: publication time unavailable');
        if (Number(time) >= range.startTs && Number(time) < range.endTs + 86400) rows.push(row);
      }
    }
    if (rows.length >= limit) return rows.slice(0, limit);
    if (seen.size >= expected) return rows;
    if (seen.size === before || data.list.length < 10) {
      throw new CommandExecutionError('weixin-channels post_list: incomplete pagination', 'Retry after the video list finishes updating.');
    }
  }
  throw new CommandExecutionError('weixin-channels post_list: incomplete pagination');
}

export async function fetchPosts(page, range, limit = 20) {
  return readPostList(page, range, limit);
}

export async function fetchPostMetrics(page, id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new ArgumentError('Video statistics ID must be an exact numeric string');
  // Identity lookup is independent of daily settlement/publication-date filters.
  const [post] = await readPostList(page, { startTs: 0, endTs: Math.floor(Date.now() / 1000) }, 1000, id);
  if (!post) throw new EmptyResultError('weixin-channels video-stats', 'Exact video ID not found in the current account');
  return post;
}

export async function fetchPostDetail(page, id, range) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new ArgumentError('--id must be a video id string');
  const auth = await bootstrap(page);
  const data = await request(page, auth, 'feed_aggreagate_data_by_tab_type', { ...periodParams(range), feedId: id });
  const retention = await request(page, auth, 'get_feed_lost_rate', { feedId: id });
  if (retention.baseResp && retention.baseResp.errcode !== 0) {
    throw new CommandExecutionError('weixin-channels get_feed_lost_rate: retention unavailable');
  }
  return { data, retention };
}
