import { describe, expect, it } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';

const command = name => [...getRegistry().values()].find(item => item.site === 'douyin' && item.name === name);
const page = response => ({ goto: async () => {}, wait: async () => {}, evaluate: async () => response });

describe('Douyin account command contracts', () => {
    it('registers a public user target and returns a projected profile', async () => {
        await import('./user.js').catch(() => {});
        const user = command('user');
        expect(user).toBeDefined();
        expect(user.args.find(arg => arg.name === 'target')).toMatchObject({ required: true, positional: true });
        expect(await user.func(page({ status_code: 0, user: { sec_uid: 'MS4', nickname: 'Test' } }), { target: 'MS4' })).toMatchObject([{ sec_uid: 'MS4', follower_count: null }]);
    });
    it('registers an explicit bounded account list choice and preserves empty-list pagination', async () => {
        await import('./account.js').catch(() => {});
        const account = command('account');
        expect(account).toBeDefined();
        expect(account.args.find(arg => arg.name === 'action').choices).toEqual(['likes', 'favorites', 'following', 'followers']);
        const browser = { goto: async () => {}, wait: async () => {}, evaluate: async script => script.includes('/profile/self/') ? { status_code: 0, user: { sec_uid: 'MS4' } } : { status_code: 0, followings: [], has_more: 0 } };
        expect(await account.func(browser, { action: 'following', limit: 2 })).toMatchObject([{ items: [], has_more: false, truncated: false }]);
    });
    it('requires explicit comment text and maps --reply-to to validated reply submission', async () => {
        await import('./comment.js').catch(() => {});
        const comment = command('comment');
        expect(comment).toBeDefined();
        expect(comment.access).toBe('write');
        expect(comment.args.find(arg => arg.name === 'text').required).toBe(true);
        expect(comment.args.find(arg => arg.name === 'reply-to')).toBeDefined();
        const result = await comment.func(page({ status_code: 0, comment: { cid: '42', text: 'hello', aweme_id: '123', reply_id: '99' } }), { target: '123', text: 'hello', 'reply-to': '99' });
        expect(result).toEqual([{ status: 'submitted', aweme_id: '123', comment_id: '42', text: 'hello', reply_to: '99' }]);
    });
});
