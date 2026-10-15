import { describe, it, expect, vi } from 'vitest';
const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./_shared/public-content.js', () => ({ listDouyinComments: acquire }));
import { getRegistry } from '@sovovs/bycli/registry';
describe('douyin comments', () => {
    it('returns structured rows and forwards validated acquisition options', async () => {
        await import('./comments.js').catch(error => { if (!/Failed to load|Cannot find/.test(error.message)) throw error; });
        const command = [...getRegistry().values()].find(cmd => cmd.site === 'douyin' && cmd.name === 'comments');
        expect(command).toBeDefined();
        acquire.mockResolvedValueOnce({ items: [{ aweme_id: '123', title: 'x' }], cursor: '10', has_more: true, truncated: true });
        const page = {};
        expect(await command.func(page, { target: '123', limit: 2, cursor: '5', replies: 1, comment_id: 'c1' })).toEqual([{ aweme_id: '123', title: 'x', cursor: '10', has_more: true, truncated: true }]);
        expect(acquire).toHaveBeenCalledWith(page, ...['123', { limit: 2, cursor: '5', replies: 1, comment_id: 'c1' }]);
    });
});
