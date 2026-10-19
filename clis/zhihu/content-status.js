import { cli, Strategy } from '@sovovs/bycli/registry';
import { stripHtml } from './text.js';
import { currentAccount } from './_shared/account.js';
import { ArgumentError } from '@sovovs/bycli/errors';
import { creatorTarget, creatorDateRange, normalizeCreatorStats } from './creator-model.js';
import { fetchCreatorStats } from './creator-client.js';
import { readOperation, withOperation, saveOperation } from './_shared/operation.js';
import { resolve } from 'node:path';

export function inspectPublicContent(target, expectedTitle, expectedBody) {
    const normalize = x => String(x || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, '');
    const url = new URL(location.href), expected = new URL(target.contentUrl);
    if (url.origin !== expected.origin || url.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return { available: false, reason: 'public_url_redirected' };
    const root = document.querySelector(target.type === 'article' ? 'article' : 'main') || document.querySelector('#root');
    const text = root?.innerText || root?.textContent || '';
    if (!root || /你似乎来到了没有知识存在的荒原|内容不存在|内容已被删除|该内容已被删除/.test(text)) return { available: false, reason: 'public_content_unavailable' };
    const titleMatch = !expectedTitle || [...root.querySelectorAll('h1')].some(n => normalize(n.textContent) === normalize(expectedTitle)) || (target.type === 'pin' && normalize(text).includes(normalize(expectedTitle)));
    const bodyMatch = !!expectedBody && normalize(text).includes(normalize(expectedBody));
    return { available: titleMatch && bodyMatch, reason: titleMatch && bodyMatch ? 'public_content_matches' : 'public_content_not_confirmed' };
}
const columns = ['operation_id', 'status', 'submitted', 'id', 'platform_type', 'public_url', 'creator_visible', 'public_visible', 'content_mark', 'sampled_at', 'message'];
cli({
    site: 'zhihu', name: 'content-status', access: 'read', domain: 'www.zhihu.com', strategy: Strategy.COOKIE,
    browser: args => !!args.target, navigateBefore: false,
    description: '读取本地提交记录，或按真实内容类型核对本人后台及公开内容；不重发',
    validateArgs: args => {
        if (!args.target && !args.operation) throw new ArgumentError('Supply --target or --operation');
        if (args.target) creatorTarget(args.target, args.type);
    },
    args: [
        { name: 'target', help: '精确作品 URL 或 article:/answer:/pin:/zvideo: ID；仅本地查询时不填' },
        { name: 'type', choices: ['article', 'answer', 'pin', 'zvideo'], help: '裸 ID 的真实平台类型' },
        { name: 'operation', help: '可选操作记录；远端内容须匹配原稿才更新，永不重新提交' },
    ], columns,
    func: async (page, args) => {
        let op = args.operation ? await readOperation(resolve(args.operation)) : null;
        if (args.operation && !op) throw new ArgumentError('Operation journal not found');
        const sampled = new Date().toISOString();
        if (!args.target) return [{ operation_id: op.operation_id, status: op.status, submitted: op.submitted, id: null, platform_type: null,
            public_url: op.public_url ?? null, creator_visible: null, public_visible: null, content_mark: null, sampled_at: sampled, message: 'Local journal only; no remote status inferred' }];
        const target = creatorTarget(args.target, args.type);
        if (!target.contentUrl) throw new ArgumentError('An answer status target needs its exact question/answer URL or answer:<questionId>:<answerId>');
        if (op && (op.kind === 'article' && (target.type !== 'article' || target.id !== op.draft_id)
            || op.kind === 'video' && (!['pin', 'zvideo'].includes(target.type) || target.id !== op.draft_id)
            || op.kind === 'answer' && (target.type !== 'answer' || !target.contentUrl.includes(`/question/${op.question_id}/answer/`)))) throw new ArgumentError('Target does not match this operation');
        let aggregate, metrics;
        try {
            const range = creatorDateRange({ days: 1 });
            const data = await fetchCreatorStats(page, target, range); aggregate = data.aggregate;
            if (op?.author_identity) await currentAccount(page, op.author_identity);
            [metrics] = normalizeCreatorStats(aggregate, data.daily, target, range, sampled);
        } catch (e) {
            if (e.code !== 'EMPTY_RESULT') throw e;
            if (op?.submitted) await withOperation(args.operation, async (file, fresh) => {
                if (fresh.operation_id !== op.operation_id) throw new ArgumentError('Operation changed during reconciliation');
                fresh.status = 'public_unavailable'; fresh.verified = false; fresh.last_remote_check = sampled;
                fresh.message = 'Work no longer identified by creator analytics; no automatic resubmission';
                await saveOperation(file, fresh);
            });
            return [{ operation_id: op?.operation_id ?? null, status: 'unavailable', submitted: op?.submitted ?? null, id: target.id,
                platform_type: target.type, public_url: target.contentUrl, creator_visible: false, public_visible: null,
                content_mark: null, sampled_at: sampled, message: 'Creator response no longer identifies this work; empty/zero statistics cannot establish its availability' }];
        }
        const content = aggregate[target.type];
        const title = op?.title || content.title || '';
        const body = op?.body || stripHtml(content.content_text || content.excerpt || '').replace(/(?:…|\.{3})$/, '').trim();
        await page.goto(target.contentUrl, { stealth: false });
        let publicState;
        for (let n = 0; n < 10; n++) {
            publicState = await page.evaluate(`(${inspectPublicContent.toString()})(${JSON.stringify(target)},${JSON.stringify(title)},${JSON.stringify(body)})`);
            if (publicState.available) break;
            await page.wait(0.5);
        }
        if (metrics.content_mark?.is_normal === false) publicState = { available: false, reason: 'creator_content_not_normal' };
        const status = publicState.available ? 'public_confirmed' : 'creator_visible';
        if (op && publicState.available) {
            if (!op.submitted) throw new ArgumentError('This journal has no submission attempt; refusing to link an already public work');
            await withOperation(args.operation, async (file, fresh) => {
                if (fresh.operation_id !== op.operation_id) throw new ArgumentError('Operation changed during reconciliation');
                fresh.status = 'public_confirmed';
                fresh.content_target = target.type === 'answer' ? `answer:${fresh.question_id}:${target.id}` : `${target.type}:${target.id}`;
                fresh.public_url = target.contentUrl;
                fresh.verified = true; fresh.message = 'Exact creator identity and public content verified';
                await saveOperation(file, fresh);
            });
        }
        return [{ operation_id: op?.operation_id ?? null, status, submitted: op?.submitted ?? null, id: target.id, platform_type: target.type,
            public_url: target.contentUrl, creator_visible: true, public_visible: publicState.available,
            content_mark: metrics.content_mark, sampled_at: sampled, message: publicState.reason }];
    },
});
