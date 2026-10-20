/** Read stable engagement metrics for a Weibo post. */
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { requireObjectEvaluateResult, unwrapEvaluateResult } from './utils.js';

export const WEIBO_STATS_COLUMNS = [
    'id', 'url', 'author', 'created_at', 'content_type',
    'reposts', 'comments', 'likes', 'collects', 'views',
];

export async function runWeiboStats(page, kwargs, contentType = 'short') {
    const id = String(kwargs?.id ?? '').trim();
    if (!id) throw new ArgumentError('Weibo post ID or mblogid is required');
    await page.goto('https://weibo.com');
    await page.wait(2);
    const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {credentials: 'include'});
        if (resp.status === 403 || resp.status === 401) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const s = await resp.json();
        if (!s.ok && !s.idstr && !s.id) return { missing: true };
        const u = s.user || {};
        return {
          id: String(s.idstr || s.id || id),
          url: 'https://weibo.com/' + String(u.id || '') + '/' + String(s.mblogid || ''),
          author: String(u.screen_name || ''),
          created_at: String(s.created_at || ''),
          content_type: ${JSON.stringify(contentType)},
          reposts: Number(s.reposts_count ?? 0),
          comments: Number(s.comments_count ?? 0),
          likes: Number(s.attitudes_count ?? 0),
          collects: Number(s.collect_count ?? s.favorites_count ?? 0),
          views: s.read_count == null ? null : Number(s.read_count),
        };
      })()
    `)), 'weibo stats');
    if (data.auth) throw new AuthRequiredError('weibo.com');
    if (data.missing) throw new EmptyResultError('weibo stats', `Post ${id} was not found`);
    if (data.error) throw new CommandExecutionError(String(data.error));
    return [data];
}

function register(name, description, contentType) {
    return cli({
        site: 'weibo', name, access: 'read', description, domain: 'weibo.com',
        strategy: Strategy.COOKIE, browser: true,
        args: [{ name: 'id', type: 'string', required: true, positional: true, help: '微博 ID 或 mblogid' }],
        columns: WEIBO_STATS_COLUMNS,
        func: (page, kwargs) => runWeiboStats(page, kwargs, contentType),
    });
}

export const shortStatsCommand = register('short-stats', '获取短微博互动数据', 'short');
export const imageStatsCommand = register('image-stats', '获取图片微博互动数据', 'image');
export const videoStatsCommand = register('video-stats', '获取视频微博互动数据', 'video');
export const articleStatsCommand = register('article-stats', '获取微博长文章互动数据', 'article');
