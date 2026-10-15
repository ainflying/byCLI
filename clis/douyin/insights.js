import { cli, Strategy } from '@sovovs/bycli/registry';
import { analyzeDouyinEvidence, readDouyinEvidence } from './_shared/analysis.js';

cli({
    site: 'douyin', name: 'insights', access: 'read', strategy: Strategy.PUBLIC, browser: false,
    description: '离线分析 JSON/JSONL 作品或 read 证据包，披露样本与启发式公式',
    args: [{ name: 'input', type: 'string', positional: true, required: true, help: 'JSON/JSONL 文件；- 从 stdin 读取（最大 8 MiB）' }],
    columns: ['sample', 'method', 'metrics', 'creators', 'topics', 'repeated_titles', 'repeated_questions', 'ranking', 'limitations'],
    func: async kwargs => [analyzeDouyinEvidence(await readDouyinEvidence(kwargs.input))],
});
