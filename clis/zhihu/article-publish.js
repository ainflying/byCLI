import { USER_CONFIRMED_ARG } from '../_shared/publish-confirmation.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { manageDraft, validateWrite, PUBLISH_COLUMNS } from './_shared/publisher.js';
cli({
    site: 'zhihu', name: 'article-publish', access: 'write', domain: 'zhuanlan.zhihu.com', strategy: Strategy.UI,
    browser: true, navigateBefore: false, siteSession: 'persistent',
    description: '重新核对文章草稿，或显式提交同一操作；有持久防重记录',
    validateArgs: args => validateWrite(args),
    args: [
        { name: 'operation', required: true, help: 'article-draft 生成的操作记录 JSON' },
        { name: 'mode', choices: ['reopen', 'resume', 'repair-cover', 'submit'], default: 'reopen', help: 'reopen 恢复并验证草稿；resume 在原页恢复中断的准备且不重传；repair-cover 显式补传同一草稿封面；submit 才会公开提交' },
        { name: 'repair-images', type: 'boolean', help: '仅 resume：核对原稿后，按原始文件顺序重建未公开草稿配图' },
        { name: 'timeout', type: 'int', default: 120, help: '草稿核对等待秒数' },
        USER_CONFIRMED_ARG,
        { name: 'execute', type: 'boolean', help: '执行当前操作' },
    ], columns: PUBLISH_COLUMNS, func: (page, args) => manageDraft(page, args, 'article'),
});
