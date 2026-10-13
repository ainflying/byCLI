import { cli, Strategy } from '@sovovs/bycli/registry';
import { fetchTotalData } from './_shared/client.js';
import { normalizeTrend, resolveDateRange } from './_shared/model.js';

export const trendCommand = cli({
  site: 'weixin-channels',
  name: 'trend',
  access: 'read',
  domain: 'channels.weixin.qq.com',
  description: '读取视频号账号逐日指标趋势，默认最近 7 天，截至昨日',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'days', type: 'int', valueRequired: true, help: '截至上海昨日的天数（默认 7）；不可与自定义日期同时使用' },
    { name: 'start-date', type: 'str', valueRequired: true, help: '开始日期 YYYY-MM-DD（包含），须同时提供 --end-date' },
    { name: 'end-date', type: 'str', valueRequired: true, help: '结束日期 YYYY-MM-DD（包含），最晚为上海昨日' },
  ],
  columns: ['date', 'views', 'recommendations', 'likes', 'comments', 'shares', 'follows'],
  func: async (page, args = {}) => {
    const range = resolveDateRange(args, new Date(), 7);
    const data = await fetchTotalData(page, range);
    return normalizeTrend(data, range);
  },
});
