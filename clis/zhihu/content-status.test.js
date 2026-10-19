import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRegistry } from '@sovovs/bycli/registry';
import { inspectPublicContent } from './content-status.js';
const target = { type: 'article', contentUrl: 'https://zhuanlan.zhihu.com/p/123' };
// Synthetic public-page contract, not a frozen live page fixture.
function inspect(html, url = target.contentUrl) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const result = dom.window.eval(`(${inspectPublicContent.toString()})(${JSON.stringify(target)},'标题','正文 第一段')`);
    dom.window.close(); return result;
}
describe('public content status', () => {
    it('preserves the question identity in a reconciled answer target', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bycli-answer-status-'));
        const file = join(dir, 'operation.json'), questionId = '2032053747652769498', answerId = '2095610166758609323';
        try {
            await writeFile(file, JSON.stringify({ version: 1, site: 'zhihu', kind: 'answer', operation_id: randomUUID(), submitted: true,
                created_at: new Date().toISOString(), status: 'submitted', title: '问题', body: '正文', images: [], image_count: 0,
                ai_generated: 'yes', question_id: questionId }));
            let call = 0;
            const page = { goto: async () => {}, evaluate: async () => {
                if (++call === 1) return { status: 200, body: { answer: { url_token: answerId }, pv: 0, content_mark: { is_normal: true } } };
                if (call === 2) return { status: 200, body: [] };
                return { available: true, reason: 'public_content_matches' };
            } };
            await getRegistry().get('zhihu/content-status').func(page, { operation: file, target: `answer:${questionId}:${answerId}` });
            expect(JSON.parse(await readFile(file, 'utf8')).content_target).toBe(`answer:${questionId}:${answerId}`);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('requires exact public URL and content, rather than a submit banner', () => {
        expect(inspect('<article><h1>标题</h1><p>正文 第一段</p></article>')).toMatchObject({ available: true });
        expect(inspect('<article><h1>标题</h1>正文 第一段</article>', 'https://zhuanlan.zhihu.com/p/999')).toMatchObject({ available: false, reason: 'public_url_redirected' });
        expect(inspect('<article>发布成功</article>').available).toBe(false);
        expect(inspect('<article><h1>标题</h1>其他正文</article>').available).toBe(false);
        expect(inspect('<article><h1>标题</h1>正文 第一段 内容已被删除</article>').available).toBe(false);
    });
    it('keeps a local-only journal query browser-free', () => {
        const cmd = getRegistry().get('zhihu/content-status');
        expect(cmd.requiresBrowser({ operation: '/tmp/x.json' })).toBe(false);
        expect(cmd.requiresBrowser({ target: 'pin:123' })).toBe(true);
    });
});
