import { cli, Strategy } from '@sovovs/bycli/registry';
import { creatorTarget, creatorDateRange, normalizeCreatorStats } from './creator-model.js';
import { fetchCreatorStats } from './creator-client.js';

export const contentStatsCommand = cli({
    site: 'zhihu', name: 'content-stats', access: 'read', domain: 'www.zhihu.com',
    strategy: Strategy.COOKIE, browser: true, navigateBefore: false,
    description: '读取本人文章/回答/想法/视频的创作后台聚合与日统计；按真实内容类型路由，浏览与播放分开',
    args: [
        { name: 'target', positional: true, required: true, help: '作品 URL、后台数据 URL 或 article:/answer:/pin:/zvideo: 精确 ID' },
        { name: 'type', choices: ['article', 'answer', 'pin', 'zvideo'], help: '裸 ID 必须指定类型；不能与 URL/typed target 冲突' },
        { name: 'days', type: 'int', valueRequired: true, help: '日趋势天数，默认7，1–366，包含上海今日' },
        { name: 'start-date', valueRequired: true, help: '日趋势起日 YYYY-MM-DD，与 end-date 成对' },
        { name: 'end-date', valueRequired: true, help: '日趋势止日 YYYY-MM-DD，最晚上海今日' },
        { name: 'aggregate', default: 'cumulative', choices: ['cumulative', 'period'], help: '累计概览或所选日趋势区间概览' },
    ],
    validateArgs: args => { creatorTarget(args.target, args.type); creatorDateRange(args); },
    columns: ['id', 'platform_type', 'media_type', 'content_url', 'stats_url', 'start_date', 'end_date', 'aggregate_scope', 'overview', 'trend', 'content_mark', 'sampled_at'],
    func: async (page, args) => {
        const target = creatorTarget(args.target, args.type), range = creatorDateRange(args);
        const { aggregate, daily } = await fetchCreatorStats(page, target, range);
        return normalizeCreatorStats(aggregate, daily, target, range);
    },
});
