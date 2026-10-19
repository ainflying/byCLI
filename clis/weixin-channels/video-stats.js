import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { fetchPostMetrics } from './_shared/client.js';
import { fetchManagementPost } from './_shared/management.js';
import { normalizePost } from './_shared/model.js';

export const VIDEO_STATS_COLUMNS = ['id', 'id_type', 'title', 'published_at', 'plays', 'recommendations', 'likes', 'comments', 'shares', 'collections', 'unavailable_metrics', 'sampled_at'];
export function videoStatsTarget(id) {
  if (typeof id !== 'string' || !(/^[0-9]+$/.test(id) || /^export\/[\w-]+$/.test(id))) throw new ArgumentError('Use an exact numeric statistics ID or export/... management ID');
  return { id, id_type: id.startsWith('export/') ? 'management' : 'statistics' };
}
export function videoMetrics(raw, target, sampledAt = new Date().toISOString()) {
  if (raw?.objectId !== target.id) throw new CommandExecutionError('Video metrics do not match the requested exact ID');
  const post = normalizePost(raw);
  const values = { plays: post.views, recommendations: post.recommendations, likes: post.likes, comments: post.comments, shares: post.shares, collections: null };
  // Neither the verified UI nor its live responses exposes a collection count.
  // API fav is the separate thumb/like metric, never a collection substitute.
  const unavailable = Object.fromEntries(Object.entries(values).filter(([, value]) => value === null)
    .map(([key]) => [key, key === 'collections' ? 'not_exposed_by_verified_backend' : 'not_returned']));
  return { id: target.id, id_type: target.id_type, title: post.title, published_at: post.published_at,
    ...values, unavailable_metrics: unavailable, sampled_at: sampledAt };
}
export const videoStatsCommand = cli({
  site: 'weixin-channels', name: 'video-stats', access: 'read', domain: 'channels.weixin.qq.com',
  strategy: Strategy.COOKIE, browser: true, navigateBefore: false,
  description: '按精确数字或管理 ID 采集视频当前累计播放、推荐、喜欢、评论、分享；收藏不可用时明确返回 null',
  args: [{ name: 'id', type: 'str', positional: true, required: true, help: '数字统计 ID 或已发表管理页 export/... ID；无需发布操作记录' }],
  validateArgs: args => { videoStatsTarget(args.id); },
  columns: VIDEO_STATS_COLUMNS,
  func: async (page, args) => {
    const target = videoStatsTarget(args.id);
    const raw = target.id_type === 'management' ? await fetchManagementPost(page, target.id) : await fetchPostMetrics(page, target.id);
    if (target.id_type === 'management' && raw.status !== 1) throw new CommandExecutionError('Management video is not published');
    return [videoMetrics(raw, target)];
  },
});
