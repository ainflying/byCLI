import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import './answer.js';
describe('zhihu answer', () => {
    it('registers as a cookie browser command', () => {
        const cmd = getRegistry().get('zhihu/answer');
        expect(cmd).toBeDefined();
        expect(cmd.strategy).toBe('cookie');
        expect(cmd.browser).toBe(true);
    });
    it('creates an answer via API and returns result', async () => {
        const cmd = getRegistry().get('zhihu/answer');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ slug: 'alice' })
                .mockResolvedValueOnce({ ok: true, id: '42', url: 'https://www.zhihu.com/question/1/answer/42' }),
        };
        const rows = await cmd.func(page, { target: 'question:1', text: 'hello', execute: true });
        expect(rows).toEqual([
            expect.objectContaining({
                outcome: 'created',
                created_target: 'answer:1:42',
                author_identity: 'alice',
            }),
        ]);
    });
    it('throws on API error', async () => {
        const cmd = getRegistry().get('zhihu/answer');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ slug: 'alice' })
                .mockResolvedValueOnce({ ok: false, status: 400, message: 'already answered' }),
        };
        await expect(cmd.func(page, { target: 'question:1', text: 'hello', execute: true }))
            .rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });
    it('requires the answer API response to include the created id', async () => {
        const cmd = getRegistry().get('zhihu/answer');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ slug: 'alice' })
                .mockResolvedValueOnce({ ok: false, status: 200, message: 'Answer API response did not include a created answer id' }),
        };
        await expect(cmd.func(page, { target: 'question:1', text: 'hello', execute: true }))
            .rejects.toMatchObject({ code: 'COMMAND_EXEC' });
        expect(page.evaluate.mock.calls[1][0]).toContain('Answer API response did not include a created answer id');
    });
});

it('preserves an unsafe numeric answer id from the raw API JSON token', async () => {
    const id = '2095538085576578974';
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn()
        .mockResolvedValueOnce({ slug: 'alice' })
        .mockImplementationOnce(js => {
            const run = new Function('fetch', `return ${js}`);
            return run(async () => ({ ok: true, status: 200, text: async () => `{"id":${id},"author":{"id":22}}` }));
        }) };
    const [row] = await getRegistry().get('zhihu/answer').func(page, { target: 'question:1', text: 'body', execute: true });
    expect(row.created_target).toBe(`answer:1:${id}`);
    expect(row.created_url).toBe(`https://www.zhihu.com/question/1/answer/${id}`);
});
