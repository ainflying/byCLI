import { cli, Strategy } from '@sovovs/bycli/registry';
import { listDouyinComments } from './_shared/public-content.js';
cli({
    site: 'douyin', name: 'comments', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '获取抖音作品评论和有界评论回复',
    args: [
        { name: 'target', type: 'string', required: true, positional: true, help: '作品 ID、链接或分享文本' },
        { name: 'limit', type: 'int', default: 20, help: '评论数量（最大 200）' },
        { name: 'cursor', type: 'string', help: '继续上次返回的 cursor' },
        { name: 'replies', type: 'int', default: 0, help: '每条评论的回复数量（最大 50，0 为不获取）' },
        { name: 'comment_id', type: 'string', help: '仅列出该评论的回复' },
    ],
    columns: ['comment_id', 'parent_comment_id', 'reply_to_comment_id', 'text', 'author', 'digg_count', 'reply_count', 'replies', 'cursor', 'has_more', 'truncated'],
    func: async (page, kwargs) => {
        const { items, ...pagination } = await listDouyinComments(page, kwargs.target, { limit: kwargs.limit, cursor: kwargs.cursor, replies: kwargs.replies, comment_id: kwargs.comment_id });
        return items.map(item => ({ ...item, ...pagination }));
    },
});
