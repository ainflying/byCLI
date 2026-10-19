import { cli, Strategy } from '@sovovs/bycli/registry';
import { exactId, statisticsRange, statsColumns } from './model.js';
import { readStatistics } from './client.js';

export function makeBaijiahaoStatsCommand(name, kind) {
  return cli({ site: 'baijiahao', name, access: 'read', domain: 'baijiahao.baidu.com', strategy: Strategy.COOKIE,
    browser: true, navigateBefore: false, description: `读取本人${kind === 'video' ? '视频播放及互动' : '图文/文章阅读及互动'}：精确管理 ID，真实 0 与缺失值分开`,
    args: [
      { name: 'id', positional: true, required: true, type: 'str', help: '精确管理 ID；不是 nid，也不按标题模糊查找' },
      { name: 'start-date', type: 'str', valueRequired: true, help: '检索起日 YYYY-MM-DD，与 end-date 成对；默认作品发表日' },
      { name: 'end-date', type: 'str', valueRequired: true, help: '检索止日 YYYY-MM-DD，最晚上海今日；不承诺计数的累计或区间口径' },
    ], validateArgs: args => { exactId(args.id); if (args['start-date'] !== undefined || args['end-date'] !== undefined) statisticsRange(args); },
    columns: statsColumns(kind), func: (page, args) => readStatistics(page, args, kind),
  });
}
