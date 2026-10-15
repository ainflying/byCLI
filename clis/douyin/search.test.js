import { describe, it, expect, vi } from 'vitest';
const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./_shared/public-content.js', () => ({ searchDouyinWorks: acquire }));
import { getRegistry } from '@sovovs/bycli/registry';
describe('douyin search', () => {
    it('returns structured rows and forwards validated acquisition options', async () => {
        await import('./search.js').catch(error => { if (!/Failed to load|Cannot find/.test(error.message)) throw error; });
        const command = [...getRegistry().values()].find(cmd => cmd.site === 'douyin' && cmd.name === 'search');
        expect(command).toBeDefined();
        acquire.mockResolvedValueOnce({ items: [{ aweme_id: '123', title: 'x' }], cursor: '10', has_more: true, truncated: true });
        const page = {};
        expect(await command.func(page, { query: 'cats', limit: 2, sort: 'latest', time: 'week', cursor: '5' })).toEqual([{ aweme_id: '123', title: 'x', cursor: '10', has_more: true, truncated: true }]);
        expect(acquire).toHaveBeenCalledWith(page, ...['cats', { limit: 2, sort: 'latest', time: 'week', cursor: '5' }]);
    });
});
