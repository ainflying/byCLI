import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { fetchPosts } from './_shared/client.js';
import { normalizePost, resolveDateRange } from './_shared/model.js';

export const postsCommand = cli({
  site: 'weixin-channels',
  name: 'posts',
  access: 'read',
  domain: 'channels.weixin.qq.com',
  description: '列出所选发布时间内的视频号作品及后台累计指标，默认最近 30 天，最多 20 条',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'days', type: 'int', valueRequired: true, help: '截至上海昨日的发布时间天数（默认 30）；不可与自定义日期同时使用' },
    { name: 'start-date', type: 'str', valueRequired: true, help: '作品发布时间起始日期 YYYY-MM-DD（包含），须同时提供 --end-date' },
    { name: 'end-date', type: 'str', valueRequired: true, help: '作品发布时间结束日期 YYYY-MM-DD（包含），最晚为上海昨日' },
    { name: 'limit', type: 'int', valueRequired: true, default: 20, help: '最多返回的作品数（1–1000 的整数，默认 20）' },
  ],
  columns: [
    'id', 'title', 'published_at', 'views', 'recommendations', 'likes', 'comments',
    'shares', 'follows', 'completion_rate', 'avg_play_seconds',
  ],
  func: async (page, args = {}) => {
    const range = resolveDateRange(args, new Date(), 30);
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new ArgumentError('--limit 必须是 1–1000 的整数');
    }
    const items = await fetchPosts(page, range, limit);
    return items.map(normalizePost);
  },
});
