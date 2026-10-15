import { cli, Strategy } from '@sovovs/bycli/registry';
import { searchDouyinWorks } from './_shared/public-content.js';
cli({
    site: 'douyin', name: 'search', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '搜索抖音作品（原生浏览器会话，支持排序和时间筛选）',
    args: [
        { name: 'query', type: 'string', required: true, positional: true, help: '搜索词' },
        { name: 'limit', type: 'int', default: 20, help: '获取数量（最大 200）' },
        { name: 'sort', type: 'string', default: 'general', choices: ['general', 'likes', 'latest'], help: '综合、最多点赞或最新' },
        { name: 'time', type: 'string', default: 'all', choices: ['all', 'day', 'week', 'halfyear'], help: '发布时间范围' },
        { name: 'cursor', type: 'string', help: '继续上次返回的 cursor' },
    ],
    columns: ['aweme_id', 'title', 'media_type', 'author', 'statistics', 'url', 'cursor', 'has_more', 'truncated'],
    func: async (page, kwargs) => {
        const { items, ...pagination } = await searchDouyinWorks(page, kwargs.query, { limit: kwargs.limit, sort: kwargs.sort, time: kwargs.time, cursor: kwargs.cursor });
        return items.map(item => ({ ...item, ...pagination }));
    },
});
