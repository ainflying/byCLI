import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import { prepareAnswer, manageDraft, validateWrite, PUBLISH_COLUMNS } from './_shared/publisher.js';
cli({
    site: 'zhihu', name: 'answer-submit', access: 'write', domain: 'www.zhihu.com', strategy: Strategy.UI,
    browser: true, navigateBefore: false, siteSession: 'persistent',
    description: '保存并核对新回答草稿，配置 AI 声明，显式提交一次；已有回答不覆盖',
    validateArgs: args => { validateWrite(args, (args.mode ?? 'prepare') === 'prepare'); if (!['prepare', 'reopen', 'submit'].includes(args.mode ?? 'prepare')) throw new ArgumentError('Invalid mode'); },
    args: [
        { name: 'target', positional: true, help: 'prepare 必填：问题 ID、question:<id> 或问题 URL' },
        { name: 'text', help: '纯文本回答内容，与 file 二选一' },
        { name: 'file', help: 'UTF-8 回答正文文件' },
        { name: 'expected-title', help: '要求问题标题完全匹配' },
        { name: 'ai-generated', choices: ['yes', 'no'], help: 'prepare 必填：是否包含 AI 辅助创作' },
        { name: 'operation', required: true, help: '持久操作记录，同一回答始终复用' },
        { name: 'mode', default: 'prepare', choices: ['prepare', 'reopen', 'submit'], help: '默认仅准备草稿；submit 才公开提交' },
        { name: 'timeout', type: 'int', default: 120, help: '每步等待秒数，回答草稿阶段最多120' },
        { name: 'execute', type: 'boolean', help: '明确执行当前阶段' },
    ], columns: PUBLISH_COLUMNS,
    func: (page, args) => (args.mode ?? 'prepare') === 'prepare' ? prepareAnswer(page, args) : manageDraft(page, args, 'answer'),
});
