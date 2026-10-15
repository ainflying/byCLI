import { cli, Strategy } from '@sovovs/bycli/registry';
import { submitDouyinComment } from './_shared/account-api.js';

cli({
    site: 'douyin', name: 'comment', access: 'write', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '显式提交一条评论或回复；仅在接口确认评论 ID 后返回 submitted',
    args: [
        { name: 'target', type: 'string', required: true, positional: true, help: '作品 ID、链接或分享文本' },
        { name: 'text', type: 'string', required: true, help: '评论内容（1–300 字符）' },
        { name: 'reply-to', type: 'string', help: '回复的评论 ID' },
    ],
    columns: ['status', 'aweme_id', 'comment_id', 'text', 'reply_to'],
    func: async (page, kwargs) => [await submitDouyinComment(page, kwargs.target, { text: kwargs.text, reply_to: kwargs['reply-to'] })],
});
