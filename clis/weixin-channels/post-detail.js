import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { fetchPostDetail } from './_shared/client.js';
import { normalizeDetail, resolveDateRange } from './_shared/model.js';

export const postDetailCommand = cli({
  site: 'weixin-channels',
  name: 'post-detail',
  access: 'read',
  domain: 'channels.weixin.qq.com',
  description: '读取单条视频号作品的概览、趋势、来源和留存，默认最近 7 天；建议使用 --format json',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'id', type: 'str', required: true, positional: true, help: 'posts 返回的作品 ID（objectId），按数字字符串原样传入' },
    { name: 'days', type: 'int', valueRequired: true, help: '截至上海昨日的统计天数（默认 7）；不可与自定义日期同时使用' },
    { name: 'start-date', type: 'str', valueRequired: true, help: '统计开始日期 YYYY-MM-DD（包含），须同时提供 --end-date' },
    { name: 'end-date', type: 'str', valueRequired: true, help: '统计结束日期 YYYY-MM-DD（包含），最晚为上海昨日' },
  ],
  columns: ['id', 'start_date', 'end_date', 'overview', 'trend', 'sources', 'retention'],
  func: async (page, args = {}) => {
    const id = args.id;
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ArgumentError('作品 ID 必须是非空的数字字符串', '请复制 weixin-channels posts 返回的 id，保留完整数字');
    }
    const range = resolveDateRange(args, new Date(), 7);
    const { data, retention } = await fetchPostDetail(page, id, range);
    return [normalizeDetail(data, retention, id, range)];
  },
});
