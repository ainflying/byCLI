import { CliError, CommandExecutionError } from '@sovovs/bycli/errors';
import { exactResultId } from './_shared/receipt.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { assertAllowedKinds, parseTarget } from './target.js';
import { buildResultRow, requireExecute, resolveCurrentUserIdentity, resolvePayload } from './write-shared.js';
cli({
    site: 'zhihu',
    name: 'answer',
    access: 'write',
    description: '旧版 API 直接创建回答；需要草稿、AI 声明及防重时使用 answer-submit',
    domain: 'www.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'target', positional: true, required: true, help: 'Zhihu question URL or typed target' },
        { name: 'text', positional: true, help: 'Answer text' },
        { name: 'file', help: 'Answer text file path' },
        { name: 'execute', type: 'boolean', help: 'Actually perform the write action' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url', 'author_identity'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for zhihu answer');
        requireExecute(kwargs);
        const rawTarget = String(kwargs.target);
        const target = assertAllowedKinds('answer', parseTarget(rawTarget));
        const payload = await resolvePayload(kwargs);
        await page.goto(target.url);
        await page.wait(3);
        const authorIdentity = await resolveCurrentUserIdentity(page);
        const apiResult = await page.evaluate(`(async () => {
            var questionId = ${JSON.stringify(target.id)};
            var content = ${JSON.stringify(payload)};
            var url = 'https://www.zhihu.com/api/v4/questions/' + questionId + '/answers';
            var resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content, reshipment_settings: 'disallowed' }),
            });
            var raw = await resp.text();
            var data; try { data = JSON.parse(raw); } catch { return { ok:false, status:resp.status, message:'Answer API returned invalid JSON' }; }
            var createdId = (${exactResultId.toString()})(raw);
            if (!resp.ok) return { ok: false, status: resp.status, message: data.error ? data.error.message : 'unknown error' };
            if (!data || !createdId) return { ok: false, status: resp.status, message: 'Answer API response did not include a created answer id' };
            return { ok: true, id: createdId, url: 'https://www.zhihu.com/question/' + questionId + '/answer/' + createdId };
        })()`);
        if (!apiResult?.ok) {
            throw new CliError('COMMAND_EXEC', apiResult?.message || 'Failed to create answer');
        }
        return buildResultRow(`Answered question ${target.id}`, target.kind, rawTarget, 'created', {
            created_target: 'answer:' + target.id + ':' + apiResult.id,
            created_url: apiResult.url,
            author_identity: authorIdentity,
        });
    },
});
