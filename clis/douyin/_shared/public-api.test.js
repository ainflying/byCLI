import { describe, it, expect, vi } from 'vitest';
import { CommandExecutionError } from '@sovovs/bycli/errors';
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('./public-content.js', () => ({ listDouyinUserWorks: list }));
import { fetchDouyinComments, fetchDouyinUserVideos } from './public-api.js';
describe('legacy public-api compatibility', () => {
    it('retains raw-video fields plus pagination for existing user-videos consumers', async () => {
        list.mockResolvedValueOnce({ items: [{ aweme_id: '123', title: 'x', duration: 1.5, play_urls: ['https://m/a'], statistics: { digg_count: null } }], cursor: '10', has_more: true, truncated: true });
        const rows = await fetchDouyinUserVideos({}, 'MS4w-user', 50, { cursor: '5' });
        expect(rows[0]).toMatchObject({ aweme_id: '123', desc: 'x', video: { duration: 1500, play_addr: { url_list: ['https://m/a'] } }, statistics: { digg_count: null } });
        expect(rows.pagination).toEqual({ cursor: '10', has_more: true, truncated: true });
        expect(list).toHaveBeenCalledWith({}, 'MS4w-user', { limit: 50, cursor: '5' });
    });
    it('rejects malformed comment collections and preserves unavailable likes as null', async () => {
        await expect(fetchDouyinComments({ evaluate: async () => ({ status_code: 0, comments: {} }) }, '123', 2)).rejects.toBeInstanceOf(CommandExecutionError);
        expect(await fetchDouyinComments({ evaluate: async () => ({ status_code: 0, comments: [{ text: 'x', user: { nickname: 'A' } }] }) }, '123', 2)).toEqual([{ text: 'x', digg_count: null, nickname: 'A' }]);
    });
});
