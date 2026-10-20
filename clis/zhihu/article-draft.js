import { cli, Strategy } from '@sovovs/bycli/registry';
import { prepareDraft, validateWrite, PUBLISH_COLUMNS } from './_shared/publisher.js';
cli({
    site: 'zhihu', name: 'article-draft', access: 'write', domain: 'zhuanlan.zhihu.com', strategy: Strategy.UI,
    browser: true, navigateBefore: false, siteSession: 'persistent',
    description: '创建知乎文章草稿，上传正文图片并重新打开核对；不发表',
    validateArgs: args => validateWrite(args, true),
    args: [
        { name: 'title', required: true, help: '文章标题，最多100字符' },
        { name: 'text', help: '纯文本正文，与 file 二选一；保留段落，不承诺 Markdown 富文本转换' },
        { name: 'file', help: 'UTF-8 纯文本正文文件' },
        { name: 'images', help: '按顺序追加到正文末尾的本地图片路径 JSON 数组' },
        { name: 'cover', help: '可选 PNG/JPEG 封面图片' },
        { name: 'ai-generated', required: true, choices: ['yes', 'no'], help: '是否包含 AI 辅助创作' },
        { name: 'operation', required: true, help: '本地持久操作记录；同一作品复用，父目录须存在' },
        { name: 'timeout', type: 'int', default: 120, help: '每步等待秒数，1–1800' },
        { name: 'execute', type: 'boolean', help: '明确执行草稿写入' },
    ], columns: PUBLISH_COLUMNS, func: (page, args) => prepareDraft(page, args, 'article'),
});
