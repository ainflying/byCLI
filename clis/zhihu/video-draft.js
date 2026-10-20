import { cli, Strategy } from '@sovovs/bycli/registry';
import { prepareDraft, validateWrite, PUBLISH_COLUMNS } from './_shared/publisher.js';
cli({
    site: 'zhihu', name: 'video-draft', access: 'write', domain: 'www.zhihu.com', strategy: Strategy.UI,
    browser: true, navigateBefore: false, siteSession: 'persistent',
    description: '上传知乎视频并保存、重开草稿；保留真实 pin/zvideo 草稿类型，不发表',
    validateArgs: args => validateWrite(args, true),
    args: [
        { name: 'video', positional: true, required: true, help: '本地视频文件；上传前须确认知乎视频协议和使用规范' },
        { name: 'title', required: true, help: '视频标题，最多80字符' },
        { name: 'text', help: '视频介绍纯文本，与 file 二选一' },
        { name: 'file', help: 'UTF-8 视频介绍文件' },
        { name: 'ai-generated', required: true, choices: ['yes', 'no'], help: '如实标注 AI 生成内容' },
        { name: 'original', required: true, choices: ['yes', 'no'], help: '是否声明原创；不得根据文件来源推测版权' },
        { name: 'category', required: true, help: '页面中的准确领域名称，如其他' },
        { name: 'operation', required: true, help: '持久操作记录 JSON，父目录须存在；同一作品复用' },
        { name: 'timeout', type: 'int', default: 180, help: '每步等待秒数，1–1800' },
        { name: 'execute', type: 'boolean', help: '执行视频上传和草稿保存' },
    ], columns: PUBLISH_COLUMNS, func: (page, args) => prepareDraft(page, args, 'video'),
});
