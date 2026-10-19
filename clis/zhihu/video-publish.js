import { cli, Strategy } from '@sovovs/bycli/registry';
import { manageDraft, validateWrite, PUBLISH_COLUMNS } from './_shared/publisher.js';
cli({
    site: 'zhihu', name: 'video-publish', access: 'write', domain: 'www.zhihu.com', strategy: Strategy.UI,
    browser: true, navigateBefore: false, siteSession: 'persistent',
    description: '恢复并核对知乎视频草稿，或显式提交一次；不把上传 ID 当成已发布作品',
    validateArgs: args => validateWrite(args),
    args: [
        { name: 'operation', required: true, help: 'video-draft 生成的持久操作记录' },
        { name: 'mode', choices: ['reopen', 'submit'], default: 'reopen', help: 'reopen 核对草稿；submit 才公开提交' },
        { name: 'timeout', type: 'int', default: 180, help: '核对等待秒数' },
        { name: 'execute', type: 'boolean', help: '执行当前操作' },
    ], columns: PUBLISH_COLUMNS, func: (page, args) => manageDraft(page, args, 'video'),
});
