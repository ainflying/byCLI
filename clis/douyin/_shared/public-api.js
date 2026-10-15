import { CommandExecutionError } from '@sovovs/bycli/errors';
import { browserFetch } from './browser-fetch.js';
import { listDouyinUserWorks } from './public-content.js';

/** Compatibility array for the original user-videos command, with resumable pagination. */
export async function fetchDouyinUserVideos(page, secUid, count, options = {}) {
    const { items, ...pagination } = await listDouyinUserWorks(page, secUid, { limit: count, ...options });
    const rows = items.map(work => ({
        ...work, desc: work.title,
        video: { duration: work.duration == null ? null : work.duration * 1000, play_addr: { url_list: work.play_urls } },
    }));
    Object.defineProperty(rows, 'pagination', { value: pagination });
    return rows;
}

// Used concurrently by user-videos, so this helper must not navigate the shared page.
export async function fetchDouyinComments(page, awemeId, count) {
    const params = new URLSearchParams({ aweme_id: String(awemeId), count: String(count), cursor: '0', aid: '6383' });
    const data = await browserFetch(page, 'GET', `https://www.douyin.com/aweme/v1/web/comment/list/?${params}`, {
        headers: { referer: 'https://www.douyin.com/' },
    });
    if (!Array.isArray(data.comments)) throw new CommandExecutionError('Malformed Douyin comment response: expected comments array');
    return data.comments.slice(0, count).map(comment => ({
        text: comment.text || '', digg_count: comment.digg_count ?? null, nickname: comment.user?.nickname || '',
    }));
}
