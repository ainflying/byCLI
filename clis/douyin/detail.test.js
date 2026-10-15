import { describe, it, expect, vi } from 'vitest';
const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./_shared/public-content.js', () => ({ getDouyinWork: acquire }));
import { getRegistry } from '@sovovs/bycli/registry';
describe('douyin detail', () => {
    it('returns structured rows and forwards validated acquisition options', async () => {
        await import('./detail.js').catch(error => { if (!/Failed to load|Cannot find/.test(error.message)) throw error; });
        const command = [...getRegistry().values()].find(cmd => cmd.site === 'douyin' && cmd.name === 'detail');
        expect(command).toBeDefined();
        acquire.mockResolvedValueOnce({ aweme_id: '123', title: 'x', statistics: { play_count: null } });
        const page = {};
        expect(await command.func(page, { target: '123' })).toEqual([{ aweme_id: '123', title: 'x', statistics: { play_count: null } }]);
        expect(acquire).toHaveBeenCalledWith(page, ...['123']);
    });
});
