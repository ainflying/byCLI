import { cli, Strategy } from '@sovovs/bycli/registry';
import { imageArgs, runImageComposer } from './_shared/image-publish.js';

cli({
    site: 'douyin', name: 'draft-images', access: 'write',
    description: '通过创作中心上传本地图片并保存图文草稿',
    domain: 'creator.douyin.com', strategy: Strategy.COOKIE, navigateBefore: false,
    args: imageArgs,
    columns: ['status', 'draft_id'],
    func: (page, kwargs) => runImageComposer(page, kwargs, 'draft'),
});
