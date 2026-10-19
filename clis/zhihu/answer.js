import { CommandExecutionError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
cli({
    site: 'zhihu',
    name: 'answer',
    access: 'write',
    description: '直接发布已停用；用 answer-submit 先保存核对草稿，用户确认后单独 submit',
    domain: 'www.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true, navigateBefore: false,
    args: [
        { name: 'target', positional: true, required: true, help: 'Zhihu question URL or typed target' },
        { name: 'text', positional: true, help: 'Answer text' },
        { name: 'file', help: 'Answer text file path' },
        { name: 'execute', type: 'boolean', help: 'Actually perform the write action' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url', 'author_identity'],
    validateArgs: () => { throw new CommandExecutionError('Direct answer publishing is disabled. Use answer-submit --mode prepare, review the saved draft with the user, then --mode submit --user-confirmed'); },
    func: async () => { throw new CommandExecutionError('Direct answer publishing is disabled; use answer-submit to save and verify a draft before user-confirmed submission'); },
});
