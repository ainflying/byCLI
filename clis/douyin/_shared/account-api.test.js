import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
const api = await import('./account-api.js').catch(() => ({}));

// Execute the actual serialized evaluator with only the network boundary faked.
function browser(responder) {
    const dom = new JSDOM('<body></body>', { url: 'https://www.douyin.com/search/test', runScripts: 'outside-only' });
    const requests = [];
    dom.window.AbortController = AbortController;
    dom.window.fetch = async (url, init = {}) => {
        const absolute = new URL(url, dom.window.location.href);
        requests.push({ url: absolute, init });
        const result = await responder(absolute, init);
        return { ok: true, status: 200, text: async () => JSON.stringify(result), json: async () => result };
    };
    return { requests, goto: async () => {}, wait: async () => {}, evaluate: script => vm.runInContext(script, dom.getInternalVMContext()) };
}
const self = { status_code: 0, user: { sec_uid: 'MS4self', uid: '90071992547409933', nickname: 'Self' } };
const user = id => ({ sec_uid: id, uid: id, nickname: id });
const work = id => ({ aweme_id: id, desc: id, author: { sec_uid: 'author' }, video: {} });

describe('Douyin account session reads', () => {
    it('returns the requested public profile with precise identifiers and null missing counts', async () => {
        expect(api.getDouyinUser).toBeTypeOf('function');
        const page = browser(() => ({ status_code: 0, user: { sec_uid: 'MS4target', uid: '90071992547409933', nickname: 'Public', cookie: 'never-export' } }));
        const result = await api.getDouyinUser(page, 'https://www.douyin.com/user/MS4target');
        expect(result).toMatchObject({ sec_uid: 'MS4target', uid: '90071992547409933', nickname: 'Public', follower_count: null });
        expect(JSON.stringify(result)).not.toContain('never-export');
        await expect(api.getDouyinUser(page, 'https://example.com/user/x')).rejects.toBeInstanceOf(CommandExecutionError);
        const wrong = browser(() => ({ status_code: 0, user: user('wrong') }));
        await expect(api.getDouyinUser(wrong, 'MS4target')).rejects.toThrow(/identity|match/i);
    });
    it('requires genuine self API identity and never uses the visited profile as current user', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser(url => url.pathname.includes('/profile/self/') ? { status_code: 0 } : { status_code: 0, user: user('visited') });
        await expect(api.listDouyinAccount(page, 'following')).rejects.toBeInstanceOf(AuthRequiredError);
        expect(page.requests).toHaveLength(1);
        await expect(api.listDouyinAccount(page, 'messages')).rejects.toBeInstanceOf(CommandExecutionError);
        await expect(api.listDouyinAccount(page, 'following', { limit: 0 })).rejects.toBeInstanceOf(CommandExecutionError);
    });
    it('bounds following pages and resumes within oversized pages without dropping users', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser(url => {
            if (url.pathname.includes('/profile/self/')) return self;
            expect(url.searchParams.get('sec_user_id')).toBe('MS4self');
            return { status_code: 0, followings: [user('a'), user('b'), user('c')], has_more: 0 };
        });
        const result = await api.listDouyinAccount(page, 'following', { limit: 2 });
        expect(result.items.map(item => item.sec_uid)).toEqual(['a', 'b']);
        expect(result).toMatchObject({ has_more: true, truncated: true, limitation: 'limit' });
        const resumed = await api.listDouyinAccount(page, 'following', { limit: 2, cursor: result.cursor });
        expect(resumed.items.map(item => item.sec_uid)).toEqual(['c']);
        expect(resumed.has_more).toBe(false);
    });
    it('advances following offsets from consumed rows, deduplicates, and binds resume cursors to the account', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser(url => {
            if (url.pathname.includes('/profile/self/')) return self;
            const offset = url.searchParams.get('offset');
            if (offset === '0') return { status_code: 0, followings: [user('a'), user('b')], offset: '0', has_more: 1 };
            expect(offset).toBe('2');
            return { status_code: 0, followings: [user('b'), user('c')], offset: '2', has_more: 0 };
        });
        expect((await api.listDouyinAccount(page, 'following', { limit: 10 })).items.map(item => item.sec_uid)).toEqual(['a', 'b', 'c']);
        const cursor = (await api.listDouyinAccount(page, 'following', { limit: 1 })).cursor;
        const otherAccount = browser(() => ({ status_code: 0, user: user('someoneElse') }));
        await expect(api.listDouyinAccount(otherAccount, 'following', { cursor })).rejects.toThrow(/account|cursor/i);
    });
    it('replays native overfetch capacity through fallback without dropping the last five users', async () => {
        const rows = Array.from({ length: 30 }, (_, index) => user(`u${index}`));
        const page = browser(url => {
            if (url.pathname.includes('/profile/self/')) return self;
            expect(url.searchParams.get('count')).toBe('30');
            return { status_code: 0, followings: rows, has_more: 0 };
        });
        let nativeRows = rows;
        let reads = 0;
        page.startNetworkCapture = async () => {};
        page.readNetworkCapture = async () => ++reads === 1 ? [] : [{
            url: `https://www.douyin.com/aweme/v1/web/user/following/list/?sec_user_id=MS4self&offset=0&count=${nativeRows.length}`,
            responsePreview: { status_code: 0, followings: nativeRows, has_more: 0 },
        }];
        const first = await api.listDouyinAccount(page, 'following', { limit: 25 });
        expect(first.items).toHaveLength(25);
        nativeRows = rows.slice(0, 20);
        const resumed = await api.listDouyinAccount(page, 'following', { limit: 25, cursor: first.cursor });
        expect(resumed.items.map(item => item.sec_uid)).toEqual(['u25', 'u26', 'u27', 'u28', 'u29']);
        expect(resumed).toMatchObject({ has_more: false, truncated: false });
        const inadequate = browser(url => url.pathname.includes('/profile/self/') ? self : { status_code: 0, followings: rows.slice(0, 20), has_more: 0 });
        await expect(api.listDouyinAccount(inadequate, 'following', { cursor: first.cursor })).rejects.toThrow(/prefix|replay|resume/i);
    });
    it('marks absent, null, empty and unrecognized pagination flags as unknown', async () => {
        for (const flag of [undefined, null, '', 'unknown', 2, {}, []]) {
            const page = browser(url => url.pathname.includes('/profile/self/') ? self : { status_code: 0, followings: [user('a')], ...(flag === undefined ? {} : { has_more: flag }) });
            expect(await api.listDouyinAccount(page, 'following')).toMatchObject({ has_more: true, truncated: true, limitation: 'pagination_unknown', cursor: null });
        }
        for (const flag of [false, 0, '0']) {
            const page = browser(url => url.pathname.includes('/profile/self/') ? self : { status_code: 0, followings: [user('a')], has_more: flag });
            expect(await api.listDouyinAccount(page, 'following')).toMatchObject({ has_more: false, truncated: false });
        }
    });
    it('uses follower time cursors and stops repeated cursors explicitly', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser(url => {
            if (url.pathname.includes('/profile/self/')) return self;
            const initial = url.searchParams.get('max_time') === '0';
            expect(url.searchParams.get('source_type')).toBe(initial ? '2' : '1');
            return { status_code: 0, followers: [user(initial ? 'a' : 'b')], max_time: '33', has_more: 1 };
        });
        const result = await api.listDouyinAccount(page, 'followers', { limit: 10 });
        expect(result.items.map(item => item.sec_uid)).toEqual(['a', 'b']);
        expect(result).toMatchObject({ has_more: true, truncated: true, limitation: 'repeated_cursor' });
    });
    it('normalizes likes and favorite works and discloses unknown pagination', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        for (const action of ['likes', 'favorites']) {
            const page = browser(url => url.pathname.includes('/profile/self/') ? self : { status_code: 0, aweme_list: [work('90071992547409930')] });
            const result = await api.listDouyinAccount(page, action);
            expect(result.items[0]).toMatchObject({ aweme_id: '90071992547409930', statistics: { play_count: null } });
            expect(result).toMatchObject({ has_more: true, truncated: true, limitation: 'pagination_unknown' });
            expect(page.requests[1].url.pathname).toBe(action === 'likes' ? '/aweme/v1/web/aweme/favorite/' : '/aweme/v1/web/aweme/listcollection/');
        }
    });
    it('uses native form-body favorite cursors and rejects responses from another owner', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser(url => {
            if (url.pathname.includes('/profile/self/')) return self;
            throw Error('native response should avoid a fallback request');
        });
        let reads = 0;
        page.startNetworkCapture = async () => {};
        page.readNetworkCapture = async () => ++reads === 1 ? [] : [{
            url: 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?aid=6383', method: 'POST',
            requestBodyPreview: 'count=10&cursor=0', responseBodyTruncated: false,
            responsePreview: { status_code: 0, sec_uid: 'MS4self', aweme_list: [work('123')], cursor: '77', has_more: 0 },
        }];
        expect((await api.listDouyinAccount(page, 'favorites')).items[0].aweme_id).toBe('123');
        page.readNetworkCapture = async () => ++reads === 3 ? [] : [{
            url: 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/', method: 'POST', requestBodyPreview: 'cursor=0',
            responsePreview: { status_code: 0, sec_uid: 'someoneElse', aweme_list: [], has_more: 0 },
        }];
        await expect(api.listDouyinAccount(page, 'favorites')).rejects.toThrow(/identity|match/i);
    });
    it('accepts an empty favorite sec_uid only with the session endpoint identity and rejects mismatching returned uid', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const response = { status_code: 0, sec_uid: '', uid: '90071992547409933', aweme_list: [work('123')], cursor: '10', has_more: 0 };
        const page = browser(url => url.pathname.includes('/profile/self/') ? self : response);
        expect((await api.listDouyinAccount(page, 'favorites')).items[0].aweme_id).toBe('123');
        response.uid = 'someoneElse';
        await expect(api.listDouyinAccount(page, 'favorites')).rejects.toThrow(/identity|match/i);
    });
    it('uses the observed native favorites POST form contract when no response capture is available', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        const page = browser((url, init) => {
            if (url.pathname.includes('/profile/self/')) return self;
            expect(init.method).toBe('POST');
            expect(init.headers['Content-Type']).toContain('application/x-www-form-urlencoded');
            expect(new URLSearchParams(init.body).get('cursor')).toBe('0');
            return { status_code: 0, aweme_list: [], cursor: '0', has_more: 0 };
        });
        expect((await api.listDouyinAccount(page, 'favorites')).items).toEqual([]);
    });
    it('throws actionable typed errors for inaccessible private data, malformed rows and rejected APIs', async () => {
        expect(api.listDouyinAccount).toBeTypeOf('function');
        for (const response of [{ status_code: 403 }, { status_code: 8 }, { status_code: 0 }, { status_code: 0, followers: 'bad' }]) {
            const page = browser(url => url.pathname.includes('/profile/self/') ? self : response);
            await expect(api.listDouyinAccount(page, 'followers')).rejects.toBeInstanceOf(response.status_code === 403 ? AuthRequiredError : CommandExecutionError);
        }
    });
});

describe('Douyin explicit comment submission', () => {
    it('validates comment and reply text before any browser request', async () => {
        expect(api.submitDouyinComment).toBeTypeOf('function');
        const page = browser(() => { throw Error('must not request'); });
        for (const text of ['', '   ', 'x'.repeat(301), 'hello\u0000']) await expect(api.submitDouyinComment(page, '123', { text })).rejects.toThrow(/text/i);
        await expect(api.submitDouyinComment(page, '123', { text: 'ok', reply_to: 'invalid!' })).rejects.toThrow(/reply/i);
        expect(page.requests).toHaveLength(0);
    });
    it('form-encodes the submission and requires confirmed cid, matching work, text and reply parent', async () => {
        expect(api.submitDouyinComment).toBeTypeOf('function');
        const page = browser((url, init) => {
            expect(url.pathname).toBe('/aweme/v1/web/comment/publish/');
            expect(init.method).toBe('POST');
            expect(init.headers['Content-Type']).toContain('application/x-www-form-urlencoded');
            const fields = new URLSearchParams(init.body);
            expect(fields.get('text')).toBe('你好 &?');
            expect(fields.get('reply_id')).toBe('991');
            return { status_code: 0, comment: { cid: '90071992547409931', aweme_id: '123', text: '你好 &?', reply_id: '991', token: 'never-export' } };
        });
        expect(await api.submitDouyinComment(page, '123', { text: '你好 &?', reply_to: '991' })).toEqual({ status: 'submitted', aweme_id: '123', comment_id: '90071992547409931', text: '你好 &?', reply_to: '991' });
    });
    it('rejects unsafe numeric work and reply echoes before confirming submission', async () => {
        const rounded = '9007199254740992';
        for (const comment of [
            JSON.parse('{"cid":"1","text":"ok","aweme_id":9007199254740993}'),
            JSON.parse('{"cid":"1","text":"ok","reply_id":9007199254740993,"withoutReplyInput":true}'),
            JSON.parse('{"cid":"1","text":"ok","aweme_id":"9007199254740992","reply_id":9007199254740993}'),
            { cid: '1', text: 'ok', aweme_id: '9007199254740993' },
            { cid: '1', text: 'ok', aweme_id: rounded, reply_id: '9007199254740993' },
        ]) {
            const page = browser(() => ({ status_code: 0, comment }));
            await expect(api.submitDouyinComment(page, rounded, { text: 'ok', ...(comment.reply_id == null || comment.withoutReplyInput ? {} : { reply_to: rounded }) })).rejects.toThrow(/unconfirmed/i);
        }
    });
    it('never reports success for rejection, absent cid or mismatched result', async () => {
        expect(api.submitDouyinComment).toBeTypeOf('function');
        for (const response of [{ status_code: 8 }, { status_code: 0 }, { status_code: 0, comment: { cid: '1', text: 'other' } }, { status_code: 0, comment: { cid: '1', text: 'ok', aweme_id: '999' } }]) {
            await expect(api.submitDouyinComment(browser(() => response), '123', { text: 'ok' })).rejects.toBeInstanceOf(CommandExecutionError);
        }
    });
});
