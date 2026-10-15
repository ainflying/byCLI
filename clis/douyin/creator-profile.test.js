import { describe, expect, it, vi } from 'vitest';
const { collect } = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock('./_shared/public-content.js', () => ({ listDouyinUserWorks: collect }));
import { getRegistry } from '@sovovs/bycli/registry';
describe('douyin creator-profile', () => {
    it('aggregates one bounded collection and retains author and native sample limitations', async () => {
        await import('./creator-profile.js').catch(() => {});
        const command = [...getRegistry().values()].find(c => c.site === 'douyin' && c.name === 'creator-profile');
        expect(command).toBeDefined();
        collect.mockResolvedValueOnce({ items: [{ aweme_id: '123', title: '#food', author: { sec_uid: 'MS4', nickname: 'Chef' }, statistics: { digg_count: 12 } }], cursor: null, has_more: true, truncated: true, limitation: 'native_page_sample' });
        const [result] = await command.func({}, { target: 'MS4', limit: 30 });
        expect(result.authors).toEqual([{ sec_uid: 'MS4', nickname: 'Chef' }]);
        expect(result.analysis.metrics.digg_count.total).toBe(12);
        expect(result.sample).toMatchObject({ work_count: 1, truncated: true, cursor: null });
        expect(collect).toHaveBeenCalledTimes(1);
        expect(collect).toHaveBeenCalledWith({}, 'MS4', { limit: 30, cursor: undefined });
    });
});
