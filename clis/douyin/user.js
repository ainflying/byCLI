import { cli, Strategy } from '@sovovs/bycli/registry';
import { getDouyinUser } from './_shared/account-api.js';

cli({
    site: 'douyin', name: 'user', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '读取抖音用户公开资料（缺失统计保留 null）',
    args: [{ name: 'target', type: 'string', required: true, positional: true, help: '用户 sec_uid、主页链接或分享文本' }],
    columns: ['sec_uid', 'uid', 'nickname', 'unique_id', 'signature', 'follower_count', 'following_count', 'aweme_count', 'total_favorited', 'url'],
    func: async (page, kwargs) => [await getDouyinUser(page, kwargs.target)],
});
