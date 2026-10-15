import { cli, Strategy } from '@sovovs/bycli/registry';
import { getDouyinWork } from './_shared/public-content.js';
cli({
    site: 'douyin', name: 'detail', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '获取抖音视频或图文作品详情和媒体地址',
    args: [{ name: 'target', type: 'string', required: true, positional: true, help: '作品 ID、链接或分享文本' }],
    columns: ['aweme_id', 'title', 'media_type', 'author', 'statistics', 'duration', 'play_url', 'images', 'url'],
    func: async (page, kwargs) => [await getDouyinWork(page, kwargs.target)],
});
