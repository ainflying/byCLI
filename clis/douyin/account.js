import { cli, Strategy } from '@sovovs/bycli/registry';
import { listDouyinAccount } from './_shared/account-api.js';

cli({
    site: 'douyin', name: 'account', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '读取当前登录账号的喜欢、收藏、关注或粉丝（有界分页）',
    args: [
        { name: 'action', type: 'string', required: true, positional: true, choices: ['likes', 'favorites', 'following', 'followers'], help: '账号列表类型' },
        { name: 'limit', type: 'int', default: 20, help: '返回上限（最大 200）' },
        { name: 'cursor', type: 'string', help: '上次结果中的不透明分页 cursor' },
    ],
    columns: ['items', 'cursor', 'has_more', 'truncated', 'limitation'],
    func: async (page, kwargs) => [await listDouyinAccount(page, kwargs.action, { limit: kwargs.limit, cursor: kwargs.cursor })],
});
