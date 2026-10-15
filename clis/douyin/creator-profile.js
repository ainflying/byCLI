import { cli, Strategy } from '@sovovs/bycli/registry';
import { listDouyinUserWorks } from './_shared/public-content.js';
import { analyzeDouyinEvidence } from './_shared/analysis.js';

cli({
    site: 'douyin', name: 'creator-profile', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '基于有界公开作品样本分析创作者，不推断受众属性或账号全量数据',
    args: [
        { name: 'target', type: 'string', required: true, positional: true, help: '用户 sec_uid 或主页链接' },
        { name: 'limit', type: 'int', default: 20, help: '作品样本上限（最大 200）' },
        { name: 'cursor', type: 'string', help: '作品分页 cursor' },
    ],
    columns: ['authors', 'sample', 'analysis', 'limitations'],
    func: async (page, kwargs) => {
        const collection = await listDouyinUserWorks(page, kwargs.target, { limit: kwargs.limit, cursor: kwargs.cursor });
        const analysis = analyzeDouyinEvidence(collection);
        return [{ authors: analysis.creators.map(creator => creator.author), sample: analysis.sample, analysis,
            limitations: [...analysis.limitations, 'Author identity is from sampled posts; follower counts and audience demographics are unavailable.'] }];
    },
});
