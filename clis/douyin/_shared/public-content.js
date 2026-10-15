import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { browserFetch } from './browser-fetch.js';
import { unwrapEvaluateResult } from './evaluate-result.js';

const ORIGIN = 'https://www.douyin.com';
const MAX_ITEMS = 200;
const MAX_PAGES = 20;
const PAGE_CAPACITY = Symbol('douyinPageCapacity');
const MAX_REPLAY_CAPACITY = 1000;
const fail = message => new CommandExecutionError(message);
const asId = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
function urls(value) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : value?.url_list ?? value?.urlList ?? (value?.url || value?.src ? [value] : []);
    return [...new Set(values.map(item => typeof item === 'string' ? item : item?.src ?? item?.url)
        .filter(url => typeof url === 'string' && /^https?:\/\//.test(url)).map(value => {
            const url = new URL(value);
            for (const key of [...url.searchParams.keys()]) if (/^(uifid|ms_?token|cookie|token|(?:access|auth|refresh)[_-]?token|authorization|session[_-]?(?:id|token))$/i.test(key)) url.searchParams.delete(key);
            return url.href;
        }))];
}
const bounded = (value, fallback = 20, maximum = MAX_ITEMS) => {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) throw fail('Douyin limit must be a positive number');
    return Math.min(maximum, Math.floor(n));
};
function checkedUrl(input) {
    let url;
    try { url = new URL(input); } catch { throw fail('Invalid Douyin URL'); }
    if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname) || url.username || url.password || url.port) {
        throw fail('Only HTTPS Douyin work, user and share URLs are supported');
    }
    return url;
}
function parseTarget(url, kind) {
    const match = kind === 'user' ? url.pathname.match(/^\/user\/([A-Za-z0-9_-]+)\/?$/) : url.pathname.match(/^\/(?:video|note|share\/video)\/(\d+)\/?$/);
    const id = match?.[1] ?? (kind === 'work' && /^\d+$/.test(url.searchParams.get('modal_id') ?? '') ? url.searchParams.get('modal_id') : null);
    if (!id) throw fail(`Douyin URL does not identify a ${kind}`);
    return { id, url: kind === 'user' ? `${ORIGIN}/user/${id}` : `${ORIGIN}/${url.pathname.includes('/note/') ? 'note' : 'video'}/${id}`, kind };
}
/** Resolve without converting long IDs to JS numbers. Short links use normal browser redirects. */
export async function resolveDouyinTarget(page, target, { kind = 'work' } = {}) {
    if (!['work', 'user'].includes(kind)) throw fail('Douyin target kind must be work or user');
    if (typeof target === 'number' && !Number.isSafeInteger(target)) throw fail('Pass Douyin IDs as strings to preserve precision');
    const text = String(target ?? '').trim();
    const bare = kind === 'work' ? /^\d+$/.test(text) : /^[A-Za-z0-9_-]+$/.test(text);
    if (bare) return { id: text, url: `${ORIGIN}/${kind === 'user' ? 'user' : 'video'}/${text}`, kind };
    const match = text.match(/https:\/\/[^\s<>"'，。！？]+/);
    if (!match) throw fail(`Expected a Douyin ${kind} ID or URL`);
    let url = checkedUrl(match[0]);
    if (url.hostname === 'v.douyin.com') {
        await page.goto(url.href);
        await page.wait?.(1);
        url = checkedUrl(unwrapEvaluateResult(await page.evaluate('location.href')));
    }
    return parseTarget(url, kind);
}

/** Stable download-oriented shape; never spread source payloads containing session information. */
export function normalizeDouyinWork(raw) {
    if (!raw || typeof raw !== 'object') throw fail('Malformed Douyin work');
    const id = asId(raw.aweme_id ?? raw.awemeId);
    if (!id || !/^\d+$/.test(id)) throw fail('Douyin work is missing a precise aweme_id');
    const video = raw.video ?? {};
    const author = raw.author ?? raw.authorInfo ?? {};
    const stats = raw.statistics ?? raw.stats ?? {};
    const images = (raw.images ?? raw.image_post_info?.images ?? raw.imagePostInfo?.images ?? []).map(image => {
        const list = urls(image.display_image ?? image.displayImage ?? image);
        return { url: list[0] ?? null, urls: list, width: numberOrNull(image.width), height: numberOrNull(image.height) };
    });
    const playUrls = [...new Set([
        ...urls(video.play_addr ?? video.playAddr),
        ...(video.bit_rate ?? video.bitRate ?? video.bitRateList ?? []).flatMap(rate => urls(rate.play_addr ?? rate.playAddr)),
    ])];
    const covers = urls(video.cover ?? video.coverUrlList ?? video.origin_cover ?? video.originCover ?? video.dynamic_cover);
    const subtitles = (video.subtitle_infos ?? video.subtitleInfos ?? raw.subtitle_infos ?? raw.subtitleInfos ?? []).map(subtitle => ({
        url: urls(subtitle)[0] ?? null,
        language: subtitle.language ?? subtitle.language_code ?? null,
        format: subtitle.format ?? null,
    })).filter(subtitle => typeof subtitle.url === 'string' && /^https?:\/\//.test(subtitle.url));
    return {
        aweme_id: id, url: `${ORIGIN}/${images.length ? 'note' : 'video'}/${id}`,
        title: String(raw.desc ?? raw.title ?? ''), media_type: images.length ? 'image' : 'video',
        author: { sec_uid: asId(author.sec_uid ?? author.secUid), nickname: String(author.nickname ?? '') },
        create_time: numberOrNull(raw.create_time ?? raw.createTime),
        duration: numberOrNull(video.duration) == null ? null : Number(video.duration) / 1000,
        statistics: Object.fromEntries(['digg_count', 'comment_count', 'collect_count', 'share_count', 'play_count'].map(key => [key, numberOrNull(stats[key] ?? stats[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())])])),
        play_url: images.length ? null : playUrls[0] ?? null, play_urls: images.length ? [] : playUrls,
        cover_url: covers[0] ?? images[0]?.url ?? null, images, subtitles,
    };
}

// Read only public content projections from known hydration roots; credentials are never returned.
async function readPageContent(page) {
    return unwrapEvaluateResult(await page.evaluate(`(() => {
        const roots = [window._ROUTER_DATA, window.__INITIAL_STATE__, window.__MODERN_ROUTER_DATA__].filter(Boolean);
        for (const script of document.querySelectorAll('script#RENDER_DATA, script#__NEXT_DATA__, script[type="application/json"]')) {
            const value = script.textContent || '';
            if (value.length > 10000000) continue;
            try { roots.push(JSON.parse(value)); } catch { try { roots.push(JSON.parse(decodeURIComponent(value))); } catch {} }
        }
        for (const anchor of Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], video, [data-e2e*="detail"], [data-e2e*="player"]')).slice(0, 200)) {
            let node = anchor;
            for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
                for (const key of Object.keys(node)) if (key.startsWith('__reactProps$')) roots.push(node[key]);
            }
        }
        function addresses(value) {
            const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : value?.url_list ?? value?.urlList ?? (value?.src || value?.url ? [value] : []);
            return { url_list: values.map(item => typeof item === 'string' ? item : item?.src ?? item?.url).filter(item => typeof item === 'string') };
        }
        function project(work) {
            const author = work.author ?? work.authorInfo ?? {}, video = work.video ?? {}, stats = work.statistics ?? work.stats ?? {};
            const statistics = {};
            for (const key of ['digg_count', 'comment_count', 'collect_count', 'share_count', 'play_count']) {
                const value = stats[key] ?? stats[key.replace(/_([a-z])/g, (_, char) => char.toUpperCase())];
                if (typeof value === 'number' || typeof value === 'string') statistics[key] = value;
            }
            return {
                aweme_id: work.aweme_id ?? work.awemeId,
                desc: typeof work.desc === 'string' ? work.desc : typeof work.title === 'string' ? work.title : '',
                create_time: work.create_time ?? work.createTime ?? null,
                author: { sec_uid: author.sec_uid ?? author.secUid ?? null, nickname: typeof author.nickname === 'string' ? author.nickname : '' },
                statistics,
                video: {
                    duration: video.duration ?? null,
                    play_addr: addresses(video.play_addr ?? video.playAddr),
                    bit_rate: (Array.isArray(video.bit_rate ?? video.bitRate ?? video.bitRateList) ? video.bit_rate ?? video.bitRate ?? video.bitRateList : []).map(rate => ({ play_addr: addresses(rate.play_addr ?? rate.playAddr) })),
                    cover: addresses(video.cover ?? video.coverUrlList ?? video.origin_cover ?? video.originCover),
                    subtitle_infos: (video.subtitle_infos ?? video.subtitleInfos ?? work.subtitle_infos ?? work.subtitleInfos ?? []).map(subtitle => ({ url: addresses(subtitle).url_list[0], language: subtitle.language ?? subtitle.language_code, format: subtitle.format })),
                },
                images: (Array.isArray(work.images ?? work.image_post_info?.images ?? work.imagePostInfo?.images) ? work.images ?? work.image_post_info?.images ?? work.imagePostInfo?.images : []).map(image => ({ ...addresses(image.display_image ?? image.displayImage ?? image), width: image.width, height: image.height })),
            };
        }
        const works = [], collections = [], visited = new Set();
        let budget = 25000;
        function walk(value, depth) {
            if (!value || typeof value !== 'object' || depth > 28 || visited.has(value) || --budget < 0) return;
            visited.add(value);
            if ((value.aweme_id || value.awemeId) && !value.cid && !value.comment_id && !value.commentId) works.push(project(value));
            if (Array.isArray(value.aweme_list)) collections.push({ aweme_list: value.aweme_list.map(project), max_cursor: value.max_cursor ?? null, ...(value.has_more == null ? {} : { has_more: value.has_more }) });
            for (const [key, child] of Object.entries(value)) if (!['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) walk(child, depth + 1);
        }
        roots.forEach(root => walk(root, 0));
        const text = (document.body?.innerText || '').slice(0, 12000);
        return { works, collections, blocked: /请完成验证|身份验证|安全验证|登录后查看|验证码验证/.test(text) };
    })()`));
}
function assertResponse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Malformed Douyin public response');
    if ('status_code' in data && Number(data.status_code) !== 0) {
        const message = String(data.status_msg ?? data.message ?? 'request failed');
        if ([401, 403].includes(Number(data.status_code)) || /login|auth|captcha|verify|登录|验证|权限/i.test(message)) throw new AuthRequiredError('www.douyin.com', 'Douyin requires login or verification in the browser');
        throw fail(`Douyin public API error ${data.status_code}`);
    }
    return data;
}
async function prepare(page, url) {
    if (page.startNetworkCapture) {
        await page.startNetworkCapture('/aweme/v1/web/');
        // Drop previously observed responses before navigating to the new target.
        await page.readNetworkCapture?.();
    }
    await page.goto(url);
    await page.wait?.(1.5);
    const state = await readPageContent(page);
    if (state?.blocked) throw new AuthRequiredError('www.douyin.com', 'Complete Douyin login or verification in the browser before retrying');
    return state ?? { works: [], collections: [] };
}
async function observedResponse(page, path, required, minimumCount = 0) {
    if (!page.readNetworkCapture) return null;
    const entries = unwrapEvaluateResult(await page.readNetworkCapture());
    if (!Array.isArray(entries)) return null;
    for (const entry of [...entries].reverse()) {
        let url;
        try { url = new URL(entry.url); } catch { continue; }
        if (url.origin !== ORIGIN || url.pathname !== path || entry.responseBodyTruncated) continue;
        if (!Object.entries(required).every(([key, value]) => value == null || url.searchParams.get(key) === String(value))) continue;
        let data = entry.responsePreview ?? entry.responseBody;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { continue; } }
        if (data) {
            const capacity = Number(url.searchParams.get('count')) || 0;
            if (capacity > 0 && capacity < minimumCount) continue;
            const result = assertResponse(data);
            result[PAGE_CAPACITY] = capacity;
            return result;
        }
    }
    return null;
}
async function request(page, path, params) {
    // A context fetch supplies cookies, but does not inherently produce a_bogus.
    // Prefer the native page's observed request above; fail clearly if this fallback is rejected.
    const result = assertResponse(await browserFetch(page, 'GET', `${ORIGIN}${path}?${new URLSearchParams({ aid: '6383', device_platform: 'webapp', ...params })}`));
    result[PAGE_CAPACITY] = Number(params.count) || 0;
    return result;
}
function workScore(work) {
    return work.play_urls.length * 8 + work.images.length * 8 + (work.cover_url ? 4 : 0) + (work.title ? 2 : 0) + (work.author.sec_uid ? 2 : 0) + (work.duration != null ? 1 : 0);
}
export async function getDouyinWork(page, target) {
    const resolved = await resolveDouyinTarget(page, target);
    const state = await prepare(page, resolved.url);
    const candidates = (state.works ?? []).filter(work => asId(work.aweme_id ?? work.awemeId) === resolved.id).map(normalizeDouyinWork).sort((a, b) => workScore(b) - workScore(a));
    if (candidates[0] && workScore(candidates[0]) > 0) return candidates[0];
    const path = '/aweme/v1/web/aweme/detail/';
    const data = await observedResponse(page, path, { aweme_id: resolved.id }) ?? await request(page, path, { aweme_id: resolved.id });
    const work = data.aweme_detail ?? data.awemeDetail ?? data.item_list?.[0];
    if (asId(work?.aweme_id ?? work?.awemeId) !== resolved.id) throw fail(`Douyin detail missing or mismatched aweme_id ${resolved.id}`);
    const normalized = normalizeDouyinWork(work);
    if (workScore(normalized) === 0) throw fail(`Douyin detail ${resolved.id} contained only an ID reference, without work data`);
    return normalized;
}

function pageCursor(data, key) {
    const cursor = data[key] ?? data.cursor ?? null;
    if (cursor != null && asId(cursor) == null) throw fail('Douyin pagination cursor must be a precise string');
    return cursor == null ? null : asId(cursor);
}
function resumeCursor(value) {
    const text = String(value);
    if (!text.startsWith('bycli:')) return { cursor: text, skip: 0 };
    try {
        const parsed = JSON.parse(decodeURIComponent(text.slice(6)));
        if (typeof parsed.cursor !== 'string' || !Number.isSafeInteger(parsed.skip) || parsed.skip < 0 || parsed.skip >= MAX_REPLAY_CAPACITY || (parsed.count != null && (!Number.isSafeInteger(parsed.count) || parsed.count < 1 || parsed.count > MAX_REPLAY_CAPACITY))) throw new Error();
        return parsed;
    } catch { throw fail('Invalid Douyin resume cursor'); }
}
async function collectPages({ limit, cursor = '0', cursorKey, fetchPage, rows, normalize, key }) {
    const resume = resumeCursor(cursor);
    const items = [], ids = new Set(), cursors = new Set([resume.cursor]);
    let next = resume.cursor, hasMore = false, truncated = false, reason;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const requestCursor = next;
        const requestedCount = pageIndex === 0 && resume.skip > 0 ? Math.max(Math.min(20, limit - items.length), resume.count ?? 0, resume.skip + 1) : Math.min(20, limit - items.length);
        const data = assertResponse(await fetchPage(next, requestedCount, pageIndex, pageIndex === 0 && resume.skip > 0 ? requestedCount : 0));
        const batch = rows(data);
        if (!Array.isArray(batch)) throw fail('Malformed Douyin response: expected an item array');
        if (pageIndex === 0 && resume.skip > 0 && batch.length <= resume.skip) throw fail('Douyin resume page could not reproduce the consumed prefix; retry with the same cursor');
        let added = 0, pendingOffset = null;
        for (let index = pageIndex === 0 ? resume.skip : 0; index < batch.length; index++) {
            const item = normalize(batch[index]);
            const id = key(item);
            if (!ids.has(id)) { ids.add(id); items.push(item); added++; }
            if (items.length >= limit) { if (index < batch.length - 1) pendingOffset = index + 1; break; }
        }
        if (data.limitation === 'native_page_sample') { next = null; hasMore = true; truncated = true; reason = 'native_page_sample'; break; }
        if (pendingOffset != null) {
            const count = Math.max(batch.length, requestedCount, data[PAGE_CAPACITY] ?? 0);
            if (count > MAX_REPLAY_CAPACITY) throw fail('Douyin native page exceeds the bounded resume capacity');
            next = `bycli:${encodeURIComponent(JSON.stringify({ cursor: requestCursor, skip: pendingOffset, count }))}`; hasMore = true; truncated = true; reason = 'limit'; break; }
        if (![true, false, 0, 1, '0', '1'].includes(data.has_more)) { next = null; hasMore = true; truncated = true; reason = 'pagination_unknown'; break; }
        hasMore = [true, 1, '1'].includes(data.has_more);
        const returnedCursor = pageCursor(data, cursorKey);
        if (returnedCursor != null) next = returnedCursor;
        if (!hasMore) break;
        if (returnedCursor == null || cursors.has(next)) { truncated = true; reason = returnedCursor == null ? 'missing_cursor' : 'repeated_cursor'; next = null; break; }
        if (items.length >= limit) { truncated = true; reason = 'limit'; break; }
        if (added === 0) { truncated = true; reason = 'no_new_items'; break; }
        cursors.add(next);
        if (pageIndex === MAX_PAGES - 1) { truncated = true; reason = 'page_limit'; }
    }
    return { items, cursor: next, has_more: hasMore, truncated, ...(reason ? { limitation: reason } : {}) };
}
export async function listDouyinUserWorks(page, target, options = {}) {
    const replaying = typeof options.cursor === 'string' && options.cursor.startsWith('bycli:');
    const limit = bounded(options.limit);
    const resolved = await resolveDouyinTarget(page, target, { kind: 'user' });
    const state = await prepare(page, resolved.url);
    const path = '/aweme/v1/web/aweme/post/';
    return collectPages({ limit, cursor: options.cursor ?? '0', cursorKey: 'max_cursor',
        rows: data => data.aweme_list, normalize: normalizeDouyinWork, key: item => item.aweme_id,
        fetchPage: async (cursor, count, index, minimumCount) => {
            const native = await observedResponse(page, path, { sec_user_id: resolved.id, max_cursor: cursor }, minimumCount);
            if (native) return native;
            if (!replaying && !index && cursor === '0') {
                const hydrated = state.collections?.find(data => Array.isArray(data.aweme_list) && data.aweme_list.every(work => asId(work.author?.sec_uid) === resolved.id));
                if (hydrated) return hydrated;
                const works = state.works?.filter(work => asId(work.author?.sec_uid ?? work.authorInfo?.secUid) === resolved.id);
                if (works?.length) return { aweme_list: works, limitation: 'native_page_sample' };
            }
            return request(page, path, { sec_user_id: resolved.id, max_cursor: cursor, count: String(count) });
        },
    });
}
function commentReference(value) {
    if (value == null || value === '' || value === 0 || value === '0') return null;
    const id = asId(value);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw fail('Douyin reply references must be precise string identifiers');
    return id;
}
function normalizeComment(raw, parentCommentId = null) {
    const id = asId(raw?.cid ?? raw?.comment_id);
    if (!id) throw fail('Malformed Douyin comment: missing comment ID');
    const suppliedParent = commentReference(raw.reply_id ?? raw.parent_comment_id ?? raw.parentCommentId);
    const replyTo = commentReference(raw.reply_to_reply_id ?? raw.reply_to_comment_id ?? raw.replyToCommentId);
    return { comment_id: id, parent_comment_id: commentReference(parentCommentId) ?? suppliedParent,
        ...(replyTo ? { reply_to_comment_id: replyTo } : {}),
        text: String(raw.text ?? ''), digg_count: numberOrNull(raw.digg_count),
        create_time: numberOrNull(raw.create_time), reply_count: numberOrNull(raw.reply_comment_total),
        author: { sec_uid: asId(raw.user?.sec_uid), nickname: String(raw.user?.nickname ?? '') }, nickname: String(raw.user?.nickname ?? '') };
}
export async function listDouyinComments(page, target, options = {}) {
    const limit = bounded(options.limit);
    const resolved = await resolveDouyinTarget(page, target);
    if (typeof options.comment_id === 'number' && !Number.isSafeInteger(options.comment_id)) throw fail('Pass Douyin comment IDs as strings to preserve precision');
    if (options.comment_id != null && !/^[A-Za-z0-9_-]+$/.test(String(options.comment_id))) throw fail('Invalid Douyin comment ID');
    const replyLimit = options.replies === true ? 10 : options.replies ? bounded(options.replies, 10, 50) : 0;
    await prepare(page, resolved.url);
    async function list(commentId, count, cursor = '0') {
        const path = commentId ? '/aweme/v1/web/comment/list/reply/' : '/aweme/v1/web/comment/list/';
        return collectPages({ limit: count, cursor, cursorKey: 'cursor', rows: data => data.comments,
            normalize: raw => normalizeComment(raw, commentId), key: item => item.comment_id,
            fetchPage: async (next, size, _index, minimumCount) => {
                const params = { aweme_id: resolved.id, cursor: next, count: String(size), ...(commentId ? { comment_id: String(commentId), item_id: resolved.id } : {}) };
                return await observedResponse(page, path, { cursor: next, ...(commentId ? { comment_id: String(commentId) } : { aweme_id: resolved.id }) }, minimumCount) ?? request(page, path, params);
            },
        });
    }
    const result = await list(options.comment_id, limit, options.cursor);
    if (!options.comment_id && replyLimit) {
        for (const comment of result.items) {
            const replies = comment.reply_count === 0 ? { items: [], cursor: '0', has_more: false, truncated: false } : await list(comment.comment_id, replyLimit);
            const { items, ...pagination } = replies;
            comment.replies = items;
            comment.replies_pagination = pagination;
        }
    }
    return result;
}
export async function searchDouyinWorks(page, query, options = {}) {
    const replaying = typeof options.cursor === 'string' && options.cursor.startsWith('bycli:');
    const keyword = String(query ?? '').trim();
    if (!keyword) throw fail('Douyin search query must not be empty');
    const sorts = { general: '0', likes: '1', latest: '2' };
    const times = { all: '0', day: '1', week: '7', halfyear: '180' };
    const sort = options.sort ?? 'general', time = options.time ?? 'all';
    if (!(sort in sorts)) throw fail('Invalid Douyin search sort: use general, likes or latest');
    if (!(time in times)) throw fail('Invalid Douyin search time: use all, day, week or halfyear');
    const limit = bounded(options.limit);
    const filter = JSON.stringify({ sort_type: sorts[sort], publish_time: times[time] });
    const state = await prepare(page, `${ORIGIN}/search/${encodeURIComponent(keyword)}?${new URLSearchParams({ type: 'video', sort_type: sorts[sort], publish_time: times[time] })}`);
    const path = '/aweme/v1/web/general/search/single/';
    let searchId = '';
    return collectPages({ limit, cursor: options.cursor ?? '0', cursorKey: 'cursor',
        rows: data => Array.isArray(data.data) ? data.data.map(item => item.aweme_info ?? item.awemeInfo ?? item).filter(item => item.aweme_id ?? item.awemeId) : data.data,
        normalize: normalizeDouyinWork, key: item => item.aweme_id,
        fetchPage: async (cursor, count, _index, minimumCount) => {
            const native = await observedResponse(page, path, { keyword, offset: cursor, ...(sort !== 'general' || time !== 'all' ? { filter_selected: filter } : {}) }, minimumCount);
            if (!native && !replaying && cursor === '0' && sort === 'general' && time === 'all' && state.works?.length) {
                return { data: state.works, limitation: 'native_page_sample' };
            }
            const data = native ?? await request(page, path, {
                keyword, search_channel: 'aweme_video_web', offset: cursor, count: String(count), filter_selected: filter,
                search_id: searchId, is_filter_search: sort === 'general' && time === 'all' ? '0' : '1',
            });
            searchId = String(data.log_pb?.impr_id ?? data.extra?.logid ?? searchId);
            return data;
        },
    });
}
