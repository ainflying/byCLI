import { cli, Strategy } from '@sovovs/bycli/registry';
import { imageArgs, runImageComposer } from './_shared/image-publish.js';

cli({
    site: 'douyin', name: 'publish-images', access: 'write',
    description: '通过创作中心立即提交图文发布（必须指定 --now）',
    domain: 'creator.douyin.com', strategy: Strategy.COOKIE, navigateBefore: false,
    args: [...imageArgs, { name: 'now', type: 'bool', default: false, help: '确认立即提交图文发布' }],
    columns: ['status', 'aweme_id', 'url'],
    func: (page, kwargs) => runImageComposer(page, kwargs, 'publish'),
});
