import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { browserFetch } from './browser-fetch.js';
import { unwrapEvaluateResult } from './evaluate-result.js';
import { normalizeDouyinWork, resolveDouyinTarget } from './public-content.js';

const ORIGIN = 'https://www.douyin.com';
const fail = message => new CommandExecutionError(message);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const count = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const PAGE_CAPACITY = Symbol('native page capacity');
const MAX_REPLAY_CAPACITY = 10000;
const BASE = { aid: '6383', device_platform: 'webapp', app_name: 'aweme' };
const LISTS = {
    likes: { path: '/aweme/v1/web/aweme/favorite/', host: 'https://www-hj.douyin.com', rows: 'aweme_list', cursor: 'max_cursor', tab: 'like' },
    favorites: { path: '/aweme/v1/web/aweme/listcollection/', rows: 'aweme_list', cursor: 'cursor', tab: 'favorite_collection' },
    following: { path: '/aweme/v1/web/user/following/list/', rows: 'followings', cursor: 'offset' },
    followers: { path: '/aweme/v1/web/user/follower/list/', rows: 'followers', cursor: 'max_time' },
};

function normalizeUser(raw) {
    const secUid = id(raw?.sec_uid);
    if (!secUid) throw fail('Douyin profile is missing a precise user identity');
    return { sec_uid: secUid, uid: id(raw.uid), nickname: String(raw.nickname ?? ''), unique_id: String(raw.unique_id ?? ''),
        signature: String(raw.signature ?? ''), url: `${ORIGIN}/user/${secUid}`,
        follower_count: count(raw.mplatform_followers_count ?? raw.follower_count), following_count: count(raw.following_count),
        aweme_count: count(raw.aweme_count), total_favorited: count(raw.total_favorited) };
}
function checked(data, label) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('status_code' in data)) throw fail(`Malformed Douyin ${label} response; open the corresponding page in the logged-in browser and retry`);
    if (Number(data.status_code) !== 0) {
        if ([401, 403].includes(Number(data.status_code)) || /login|auth|captcha|verify|private|permission|登录|验证|隐私|权限/i.test(String(data.status_msg ?? data.message ?? ''))) {
            throw new AuthRequiredError('www.douyin.com', `Douyin ${label} is inaccessible; complete browser login/verification and check account privacy permissions`);
        }
        throw fail(`Douyin ${label} API rejected the request; open the corresponding browser page to complete verification and retry`);
    }
    return data;
}
async function get(page, path, params = {}, host = ORIGIN) {
    return browserFetch(page, 'GET', `${host}${path}?${new URLSearchParams({ ...BASE, ...params })}`);
}
async function captureStart(page) {
    if (page.startNetworkCapture) {
        await page.startNetworkCapture('/aweme/v1/web/');
        await page.readNetworkCapture?.();
    }
}
async function captured(page, path, required, cache = [], minimumCount = 0, rowKey) {
    if (!page.readNetworkCapture) return null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const entries = unwrapEvaluateResult(await page.readNetworkCapture());
        if (Array.isArray(entries)) cache.push(...entries);
        if (cache.length > 400) cache.splice(0, cache.length - 400);
        for (const entry of [...cache].reverse()) {
            let url;
            try { url = new URL(entry.url); } catch { continue; }
            if (!['www.douyin.com', 'www-hj.douyin.com'].includes(url.hostname) || url.pathname !== path || entry.responseBodyTruncated) continue;
            let fields = {};
            if (typeof entry.requestBodyPreview === 'string' && !entry.requestBodyTruncated) {
                try { fields = JSON.parse(entry.requestBodyPreview); } catch { fields = Object.fromEntries(new URLSearchParams(entry.requestBodyPreview)); }
            }
            if (!Object.entries(required).every(([key, value]) => (url.searchParams.get(key) ?? fields?.[key]) === String(value))) continue;
            let body = entry.responsePreview ?? entry.responseBody;
            if (typeof body === 'string') { try { body = JSON.parse(body); } catch { continue; } }
            if (body && Object.hasOwn(body, 'status_code')) {
                const requestedCount = Number(url.searchParams.get('count') ?? fields?.count);
                const capacity = Math.max(Number.isSafeInteger(requestedCount) && requestedCount > 0 ? requestedCount : 0, Array.isArray(body[rowKey]) ? body[rowKey].length : 0);
                if (minimumCount && capacity < minimumCount) continue;
                return { ...body, [PAGE_CAPACITY]: capacity };
            }
        }
        if (attempt < 4) await page.wait?.({ time: 0.4 });
    }
    return null;
}
async function formRequest(page, path, fields) {
    const script = `(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(${JSON.stringify(`${ORIGIN}${path}?${new URLSearchParams(BASE)}`)}, {
                method: 'POST', credentials: 'include', signal: controller.signal,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(${JSON.stringify(fields)}).toString()
            });
            if (!response.ok) return { status_code: response.status };
            try { return JSON.parse(await response.text()); } catch { return { status_code: -2 }; }
        } catch { return { status_code: -1 }; }
        finally { clearTimeout(timer); }
    })()`;
    return unwrapEvaluateResult(await page.evaluate(script));
}

export async function getDouyinUser(page, target) {
    const resolved = await resolveDouyinTarget(page, target, { kind: 'user' });
    await captureStart(page);
    await page.goto(resolved.url);
    await page.wait?.(1);
    const path = '/aweme/v1/web/user/profile/other/';
    const data = checked(await captured(page, path, { sec_user_id: resolved.id }) ?? await get(page, path, { sec_user_id: resolved.id }), 'public profile');
    const user = normalizeUser(data.user);
    if (user.sec_uid !== resolved.id) throw fail('Douyin profile identity does not match the requested user');
    return user;
}
async function currentSelf(page) {
    // Only a genuine self endpoint may establish ownership. A visited profile is not evidence.
    const data = checked(await get(page, '/aweme/v1/web/user/profile/self/'), 'current-account identity');
    if (!id(data.user?.sec_uid)) throw new AuthRequiredError('www.douyin.com', 'Cannot establish the current account from the self API; log in on www.douyin.com and retry');
    return normalizeUser(data.user);
}
function resume(value, action, owner) {
    const text = String(value ?? '0');
    if (/^\d+$/.test(text)) return { position: text, skip: 0 };
    try {
        if (!text.startsWith('account:')) throw Error();
        const data = JSON.parse(decodeURIComponent(text.slice(8)));
        if (data.action !== action || data.owner !== owner || !/^\d+$/.test(data.position) || !Number.isSafeInteger(data.skip) || data.skip < 0 || data.skip >= MAX_REPLAY_CAPACITY || data.count != null && (!Number.isSafeInteger(data.count) || data.count < 1 || data.count > MAX_REPLAY_CAPACITY)) throw Error();
        return data;
    } catch { throw fail('Invalid Douyin account cursor or cursor belongs to a different account/list'); }
}
function cursorToken(action, owner, position, skip = 0, count) {
    return `account:${encodeURIComponent(JSON.stringify({ action, owner, position, skip, ...(count == null ? {} : { count }) }))}`;
}

export async function listDouyinAccount(page, action, options = {}) {
    if (!Object.hasOwn(LISTS, action)) throw fail('Account action must be likes, favorites, following or followers');
    const requested = Number(options.limit ?? 20);
    if (!Number.isInteger(requested) || requested < 1) throw fail('Douyin account limit must be a positive integer');
    const limit = Math.min(requested, 200), config = LISTS[action];
    // Validate the cursor shape before browser access; account binding is checked after self lookup.
    if (options.cursor != null && !/^\d+$/.test(String(options.cursor)) && !String(options.cursor).startsWith('account:')) throw fail('Invalid Douyin account cursor');
    const self = await currentSelf(page);
    const initial = resume(options.cursor, action, self.sec_uid);
    await captureStart(page);
    await page.goto(`${self.url}${config.tab ? `?showTab=${config.tab}` : ''}`);
    await page.wait?.(1);
    let position = initial.position, hasMore = false, limitation;
    const items = [], seen = new Set(), positions = new Set([position]), native = [];
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const replaying = pageIndex === 0 && initial.skip > 0;
        const requestedCount = replaying ? Math.max(Math.min(20, limit), initial.count ?? 0, initial.skip + 1) : 20;
        const params = { count: String(requestedCount), [config.cursor]: position };
        if (action !== 'favorites') params.sec_user_id = self.sec_uid;
        if (action === 'likes') params.cursor = position;
        if (action === 'followers') params.source_type = position === '0' ? '2' : '1';
        const required = { [config.cursor]: position, ...(action === 'favorites' ? {} : { sec_user_id: self.sec_uid }) };
        let data;
        try {
            const observed = await captured(page, config.path, required, native, replaying ? requestedCount : 0, config.rows);
            data = checked(observed ?? (action === 'favorites' ? await formRequest(page, config.path, { count: params.count, cursor: position }) : await get(page, config.path, params, config.host)), action);
        }
        catch (error) {
            if (error instanceof AuthRequiredError) throw error;
            throw fail(`Douyin ${action} is unavailable in this browser session; open your ${config.tab ?? action} page, complete verification and retry${action === 'likes' ? ' (the native likes endpoint requires browser SecSDK signing)' : ''}`);
        }
        if (data.sec_uid && String(data.sec_uid) !== self.sec_uid || data.uid != null && data.uid !== '' && self.uid != null && id(data.uid) !== self.uid) throw fail('Douyin account response identity does not match the current account');
        const rows = data[config.rows];
        if (!Array.isArray(rows)) throw fail(`Malformed or inaccessible Douyin ${action} list; check privacy permissions on the corresponding browser page`);
        if (replaying && rows.length <= initial.skip) throw fail('Douyin account resume page could not reproduce the consumed prefix; retry with the same cursor');
        let added = 0;
        for (let index = pageIndex === 0 ? initial.skip : 0; index < rows.length; index++) {
            const item = config.rows === 'aweme_list' ? normalizeDouyinWork(rows[index]) : normalizeUser(rows[index]);
            const key = item.aweme_id ?? item.sec_uid;
            if (!seen.has(key)) { seen.add(key); items.push(item); added++; }
            if (items.length >= limit && index < rows.length - 1) {
                const capacity = Math.max(rows.length, data[PAGE_CAPACITY] ?? requestedCount);
                if (capacity > MAX_REPLAY_CAPACITY) throw fail('Douyin native page exceeds the bounded account resume capacity');
                return { items, cursor: cursorToken(action, self.sec_uid, position, index + 1, capacity), has_more: true, truncated: true, limitation: 'limit' };
            }
        }
        if (![true, false, 1, 0, '1', '0'].includes(data.has_more)) { hasMore = true; position = null; limitation = 'pagination_unknown'; break; }
        hasMore = data.has_more === true || Number(data.has_more) === 1;
        let next = data[config.cursor];
        if (action === 'following') next = String(BigInt(position) + BigInt(rows.length));
        if (typeof next === 'number' && !Number.isSafeInteger(next)) next = null;
        next = next == null ? null : String(next);
        if (!hasMore) { position = next; break; }
        if (next == null || !/^\d+$/.test(next)) { position = null; limitation = 'missing_cursor'; break; }
        if (positions.has(next)) { position = next; limitation = 'repeated_cursor'; break; }
        position = next;
        if (items.length >= limit) { limitation = 'limit'; break; }
        if (!added) { limitation = 'no_new_items'; break; }
        positions.add(next);
        if (pageIndex === 19) limitation = 'page_limit';
    }
    return { items, cursor: position == null ? null : cursorToken(action, self.sec_uid, position), has_more: hasMore, truncated: Boolean(limitation), ...(limitation ? { limitation } : {}) };
}

export async function submitDouyinComment(page, target, options = {}) {
    const text = options.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('Comment text must contain 1–300 characters without control characters');
    const reply = options.reply_to ?? null;
    if (reply != null && (typeof reply !== 'string' || !/^\d+$/.test(reply))) throw fail('Reply parent must be a precise numeric comment ID string');
    const resolved = await resolveDouyinTarget(page, target);
    await page.goto(resolved.url);
    await page.wait?.(1);
    const fields = { aweme_id: resolved.id, comment_send_celltime: '3250', comment_video_celltime: '1000', one_level_comment_rank: '-1', paste_edit_method: 'non_paste', text, text_extra: '[]', ...(reply ? { reply_id: reply } : {}) };
    // browserFetch serializes JSON bodies; this native endpoint requires a form.
    let data;
    try { data = checked(await formRequest(page, '/aweme/v1/web/comment/publish/', fields), 'comment submission'); }
    catch (error) {
        if (error instanceof AuthRequiredError) throw error;
        throw fail('Douyin comment submission was rejected or the outcome is unconfirmed; inspect the work in your browser before retrying to avoid duplicates');
    }
    const comment = data.comment;
    const cid = id(comment?.cid);
    if (!cid || !/^\d+$/.test(cid) || comment.text !== text || comment.aweme_id != null && id(comment.aweme_id) !== resolved.id || comment.reply_id != null && id(comment.reply_id) == null || reply && id(comment.reply_id) !== reply) {
        throw fail('Douyin comment outcome is unconfirmed; inspect the work in your browser before retrying to avoid duplicates');
    }
    return { status: 'submitted', aweme_id: resolved.id, comment_id: cid, text: comment.text, reply_to: reply };
}
