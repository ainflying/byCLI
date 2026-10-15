import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
// A missing module is an unimplemented public contract, not a collection error.
const api = await import('./public-content.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || /Failed to load/.test(error.message)) return {};
    throw error;
});
function makePage({ state = {}, responses = [], captures = [], redirect } = {}) {
    const requests = [];
    const location = { href: 'https://www.douyin.com/' };
    const context = { window: { _ROUTER_DATA: state }, location, URL, URLSearchParams,
        document: { body: { innerText: '' }, querySelectorAll: () => [] },
        AbortController, setTimeout, clearTimeout,
        fetch: async (url) => {
            requests.push(new URL(url));
            const body = responses.shift() ?? { status_code: 0, aweme_list: [], has_more: 0 };
            return { ok: true, status: 200, text: async () => JSON.stringify(body) };
        },
    };
    const page = { goto: vi.fn(async url => { location.href = redirect ?? url; }), wait: vi.fn(),
        evaluate: vi.fn(async js => vm.runInNewContext(js, context)),
        startNetworkCapture: vi.fn(async () => true), readNetworkCapture: vi.fn(async () => captures),
    };
    return { page, requests, context };
}
const video = id => ({ aweme_id: id, desc: 'work ' + id, author: { sec_uid: 'MS4w-author', nickname: 'A' }, video: { duration: 2500, play_addr: { url_list: ['https://media.example/' + id] } } });
describe('Douyin public content', () => {
    it('exposes the public acquisition contract', () => {
        expect(typeof api.resolveDouyinTarget).toBe('function');
        expect(typeof api.normalizeDouyinWork).toBe('function');
    });
    it('preserves numeric work IDs as strings and resolves supported URL forms', async () => {
        const { page } = makePage();
        expect(await api.resolveDouyinTarget(page, '7654321098765432109')).toEqual({ id: '7654321098765432109', url: 'https://www.douyin.com/video/7654321098765432109', kind: 'work' });
        expect((await api.resolveDouyinTarget(page, 'https://www.douyin.com/note/123?x=1')).id).toBe('123');
        expect((await api.resolveDouyinTarget(page, 'https://www.douyin.com/?modal_id=456')).id).toBe('456');
        expect((await api.resolveDouyinTarget(page, 'MS4w-user', { kind: 'user' })).url).toBe('https://www.douyin.com/user/MS4w-user');
    });
    it('resolves share text through native navigation and validates the final host', async () => {
        const { page } = makePage({ redirect: 'https://www.douyin.com/video/123' });
        expect((await api.resolveDouyinTarget(page, '复制打开抖音 https://v.douyin.com/AbC/ 观看')).id).toBe('123');
        await expect(api.resolveDouyinTarget(makePage({ redirect: 'https://evil.example/video/123' }).page, 'https://v.douyin.com/AbC/')).rejects.toBeInstanceOf(CommandExecutionError);
    });
    it('rejects foreign hosts, unsafe IDs, and user/work confusion before navigation', async () => {
        const { page } = makePage();
        for (const target of ['https://douyin.com.evil.example/video/123', 'https://evil.example/video/123', 'https://www.douyin.com/user/abc', '123/../../x']) {
            await expect(api.resolveDouyinTarget(page, target)).rejects.toBeInstanceOf(CommandExecutionError);
        }
        expect(page.goto).not.toHaveBeenCalled();
        await expect(api.resolveDouyinTarget(page, 7654321098765432109)).rejects.toThrow(/string|precision/i);
    });
    it('normalizes video variants, milliseconds, subtitles and unavailable metrics', () => {
        const result = api.normalizeDouyinWork({ ...video('123'), statistics: { digg_count: 0, comment_count: 8 }, video: { duration: 2500, play_addr: { url_list: ['https://m/a', 'https://m/b'] }, cover: { url_list: ['https://m/cover'] }, subtitle_infos: [{ url: 'https://m/sub', language: 'zh' }] } });
        expect(result).toMatchObject({ aweme_id: '123', title: 'work 123', media_type: 'video', duration: 2.5, play_url: 'https://m/a', play_urls: ['https://m/a', 'https://m/b'], cover_url: 'https://m/cover', statistics: { digg_count: 0, comment_count: 8, play_count: null, share_count: null }, subtitles: [{ url: 'https://m/sub', language: 'zh' }] });
        expect(api.normalizeDouyinWork({ aweme_id: '123', desc: 'x' }).statistics.play_count).toBeNull();
    });
    it('normalizes image galleries with safe image and download fields', () => {
        expect(api.normalizeDouyinWork({ aweme_id: '8', images: [{ url_list: ['https://m/1', 'https://m/2'], width: 300, height: 400 }] })).toMatchObject({ media_type: 'image', play_url: null, images: [{ url: 'https://m/1', urls: ['https://m/1', 'https://m/2'], width: 300, height: 400 }] });
        expect(() => api.normalizeDouyinWork({})).toThrow(/aweme|work/i);
    });
    it('reads matching detail from rendered page state before trying unsigned fetch', async () => {
        const { page, requests } = makePage({ state: { loaderData: { detail: { aweme_detail: video('123') } } } });
        expect((await api.getDouyinWork(page, '123')).title).toBe('work 123');
        expect(requests).toHaveLength(0);
    });
    it('uses observed native responses for detail and excludes unrelated IDs', async () => {
        const { page } = makePage({ captures: [{ url: 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123', responsePreview: JSON.stringify({ status_code: 0, aweme_detail: video('123') }) }] });
        expect((await api.getDouyinWork(page, '123')).aweme_id).toBe('123');
        await expect(api.getDouyinWork(makePage({ responses: [{ status_code: 0, aweme_detail: video('99') }] }).page, '123')).rejects.toThrow(/123|mismatch/i);
    });
    it('deduplicates list pages and exposes truncation on repeated cursors', async () => {
        const { page, requests } = makePage({ responses: [
            { status_code: 0, aweme_list: [video('1'), video('2')], max_cursor: '10', has_more: 1 },
            { status_code: 0, aweme_list: [video('2'), video('3')], max_cursor: '10', has_more: 1 },
        ] });
        const result = await api.listDouyinUserWorks(page, 'MS4w-user', { limit: 10 });
        expect(result.items.map(x => x.aweme_id)).toEqual(['1', '2', '3']);
        expect(result).toMatchObject({ cursor: null, has_more: true, truncated: true, limitation: 'repeated_cursor' });
        expect(requests).toHaveLength(2);
        expect(requests[1].searchParams.get('max_cursor')).toBe('10');
    });
    it('caps user pages, reports a resumable cursor, and preserves initial cursor', async () => {
        const { page, requests } = makePage({ responses: [{ status_code: 0, aweme_list: [video('2')], max_cursor: '20', has_more: 1 }] });
        expect(await api.listDouyinUserWorks(page, 'MS4w-user', { limit: 1, cursor: '10' })).toMatchObject({ cursor: '20', has_more: true, truncated: true });
        expect(requests[0].searchParams.get('max_cursor')).toBe('10');
    });
    it('sends validated search filters and returns normalized result rows', async () => {
        const { page, requests } = makePage({ responses: [{ status_code: 0, data: [{ aweme_info: video('9') }], cursor: '1', has_more: 0 }] });
        const result = await api.searchDouyinWorks(page, '猫', { sort: 'likes', time: 'week', limit: 2 });
        expect(result.items[0].aweme_id).toBe('9');
        expect(requests[0].searchParams.get('keyword')).toBe('猫');
        expect(JSON.parse(requests[0].searchParams.get('filter_selected'))).toMatchObject({ sort_type: '1', publish_time: '7' });
        await expect(api.searchDouyinWorks(page, '猫', { sort: 'invalid' })).rejects.toThrow(/sort/i);
        await expect(api.searchDouyinWorks(page, '猫', { time: 'invalid' })).rejects.toThrow(/time/i);
    });
    it('normalizes comments and fetches bounded replies with separate pagination', async () => {
        const { page, requests } = makePage({ responses: [
            { status_code: 0, comments: [{ cid: 'c1', text: 'hello', reply_comment_total: 2, user: { sec_uid: 'MS4w-c', nickname: 'C' } }], cursor: '1', has_more: 0 },
            { status_code: 0, comments: [{ cid: 'r1', text: 'reply', user: { nickname: 'R' } }], cursor: '1', has_more: 1 },
        ] });
        const result = await api.listDouyinComments(page, '123', { limit: 1, replies: 1 });
        expect(result.items[0]).toMatchObject({ comment_id: 'c1', text: 'hello', digg_count: null, replies: [{ comment_id: 'r1', text: 'reply' }], replies_pagination: { has_more: true, truncated: true } });
        expect(requests[1].pathname).toContain('/comment/list/reply/');
        expect(requests[1].searchParams.get('comment_id')).toBe('c1');
    });
    it('supports reply-only cursor traversal', async () => {
        const { page, requests } = makePage({ responses: [{ status_code: 0, comments: [], cursor: '3', has_more: 0 }] });
        expect(await api.listDouyinComments(page, '123', { comment_id: 'c1', cursor: '2' })).toMatchObject({ items: [], cursor: '3', has_more: false, truncated: false });
        expect(requests[0].searchParams.get('cursor')).toBe('2');
    });
    it('normalizes live camelCase React work media and strips account query identifiers', () => {
        const work = api.normalizeDouyinWork({ awemeId: '123', createTime: 10, authorInfo: { secUid: 'MS4w-user', nickname: 'A' }, stats: { playCount: 6 }, video: {
            duration: 1000, playAddr: [{ src: 'https://cdn.example/a?uifid=private&x=1' }],
            bitRateList: [{ playAddr: [{ src: 'https://cdn.example/b' }] }], cover: 'https://cdn.example/cover',
        } });
        expect(work).toMatchObject({ aweme_id: '123', create_time: 10, play_url: 'https://cdn.example/a?x=1', play_urls: ['https://cdn.example/a?x=1', 'https://cdn.example/b'], cover_url: 'https://cdn.example/cover', statistics: { play_count: 6 } });
    });
    it('extracts live React search cards as an explicitly limited native page sample', async () => {
        const { page, requests, context } = makePage();
        const props = { children: { props: { data: { awemeInfo: video('123') } } } };
        props._owner = props;
        const anchor = { '__reactProps$fixture': props };
        context.document.querySelectorAll = selector => selector.startsWith('a[') ? [anchor] : [];
        const result = await api.searchDouyinWorks(page, 'cats', { limit: 10 });
        expect(result.items.map(work => work.aweme_id)).toEqual(['123']);
        expect(result).toMatchObject({ cursor: null, has_more: true, truncated: true, limitation: 'native_page_sample' });
        expect(requests).toHaveLength(0);
    });
    it('does not misidentify comment hydration objects as work details', async () => {
        const { page } = makePage({ state: { comment: { cid: 'c1', aweme_id: '123', text: 'not a work' } }, responses: [{ status_code: 0, aweme_detail: video('123') }] });
        expect((await api.getDouyinWork(page, '123')).title).toBe('work 123');
    });
    it('returns a scoped native profile sample if unsigned user feeds are unavailable', async () => {
        const { page, requests, context } = makePage();
        const anchor = { '__reactProps$x': { children: [{ props: { data: { awemeInfo: { ...video('123'), author: { sec_uid: 'MS4w-user' } } } } }, { props: { data: { awemeInfo: video('456') } } }] } };
        context.document.querySelectorAll = selector => selector.startsWith('a[') ? [anchor] : [];
        const result = await api.listDouyinUserWorks(page, 'MS4w-user', { limit: 5 });
        expect(result.items.map(work => work.aweme_id)).toEqual(['123']);
        expect(result).toMatchObject({ cursor: null, truncated: true, limitation: 'native_page_sample' });
        expect(requests).toHaveLength(0);
    });
    it('marks unavailable pagination explicitly rather than claiming feed exhaustion', async () => {
        const { page } = makePage({ responses: [{ status_code: 0, aweme_list: [video('1')] }] });
        expect(await api.listDouyinUserWorks(page, 'MS4w-user')).toMatchObject({ has_more: true, truncated: true, cursor: null, limitation: 'pagination_unknown' });
    });
    it('selects full detail data over sparse routing references with the same ID', async () => {
        const { page } = makePage({ state: { route: { aweme_id: '123' }, player: { awemeInfo: video('123') } } });
        expect(await api.getDouyinWork(page, '123')).toMatchObject({ title: 'work 123', duration: 2.5, play_url: 'https://media.example/123' });
    });
    it('rejects sparse references instead of returning empty detail success', async () => {
        const { page } = makePage({ state: { route: { aweme_id: '123' } }, responses: [{ status_code: 0, aweme_detail: { aweme_id: '123' } }] });
        await expect(api.getDouyinWork(page, '123')).rejects.toBeInstanceOf(CommandExecutionError);
    });
    it('projects cyclic React work objects before crossing the browser bridge', async () => {
        const work = video('123'); work._owner = work;
        const { page } = makePage({ state: { player: { awemeInfo: work } } });
        const evaluate = page.evaluate;
        page.evaluate = async js => JSON.parse(JSON.stringify(await evaluate(js)));
        expect((await api.getDouyinWork(page, '123')).play_url).toBe('https://media.example/123');
    });
    it('resumes within oversized server pages without skipping unreturned comments', async () => {
        const response = { status_code: 0, comments: [{ cid: 'c1', text: '1' }, { cid: 'c2', text: '2' }, { cid: 'c3', text: '3' }], cursor: '3', has_more: 0 };
        const first = await api.listDouyinComments(makePage({ responses: [response] }).page, '123', { limit: 1 });
        expect(first.items.map(comment => comment.comment_id)).toEqual(['c1']);
        expect(first.has_more).toBe(true);
        const { page, requests } = makePage({ responses: [response] });
        const next = await api.listDouyinComments(page, '123', { limit: 2, cursor: first.cursor });
        expect(next.items.map(comment => comment.comment_id)).toEqual(['c2', 'c3']);
        expect(next).toMatchObject({ cursor: '3', has_more: false, truncated: false });
        expect(requests[0].searchParams.get('cursor')).toBe('0');
    });
    it('removes credential query parameters from every subtitle URL alias while retaining CDN signatures', () => {
        const work = api.normalizeDouyinWork({ aweme_id: '123', video: { subtitle_infos: [
            { url: 'https://cdn.example/sub?sessionid=private&msToken=private&uifid=private&auth_token=private&X-Amz-Signature=cdn-signature&language=zh' },
            { url_list: ['https://cdn.example/sub2?access_token=private&signature=cdn-signature'] },
        ] } });
        expect(work.subtitles.map(item => item.url)).toEqual([
            'https://cdn.example/sub?X-Amz-Signature=cdn-signature&language=zh',
            'https://cdn.example/sub2?signature=cdn-signature',
        ]);
    });
    it('sanitizes camelCase subtitle descriptors and source aliases', () => {
        const work = api.normalizeDouyinWork({ aweme_id: '123', subtitleInfos: [
            { src: 'https://cdn.example/sub?authToken=private&signature=cdn-signature' },
            { urlList: ['https://cdn.example/sub2?session_id=private&signature=cdn-signature'] },
        ] });
        expect(work.subtitles.map(item => item.url)).toEqual(['https://cdn.example/sub?signature=cdn-signature', 'https://cdn.example/sub2?signature=cdn-signature']);
    });
    it('retains top-level subtitle aliases through native browser projection', async () => {
        for (const key of ['subtitle_infos', 'subtitleInfos']) {
            const { page } = makePage({ state: { player: { ...video('123'), [key]: [{ src: 'https://cdn.example/sub.vtt?sessionid=private&signature=cdn' }] } } });
            expect((await api.getDouyinWork(page, '123')).subtitles).toMatchObject([{ url: 'https://cdn.example/sub.vtt?signature=cdn' }]);
        }
    });
    it('replays captured page capacity when a smaller follow-up uses count-respecting fetch', async () => {
        const comments = Array.from({ length: 20 }, (_, index) => ({ cid: 'c' + (index + 1), text: String(index + 1) }));
        const firstPage = makePage({ captures: [{ url: 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=123&cursor=0&count=20', responsePreview: JSON.stringify({ status_code: 0, comments, cursor: '20', has_more: 1 }) }] });
        const first = await api.listDouyinComments(firstPage.page, '123', { limit: 1 });
        expect(first.items.map(item => item.comment_id)).toEqual(['c1']);
        const nextPage = makePage();
        nextPage.context.fetch = async url => {
            const request = new URL(url); nextPage.requests.push(request);
            const count = Number(request.searchParams.get('count'));
            return { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 0, comments: comments.slice(0, count), cursor: String(count), has_more: 1 }) };
        };
        const next = await api.listDouyinComments(nextPage.page, '123', { limit: 1, cursor: first.cursor });
        expect(next.items.map(item => item.comment_id)).toEqual(['c2']);
        expect(nextPage.requests[0].searchParams.get('count')).toBe('20');
        const thirdPage = makePage({ responses: [{ status_code: 0, comments, cursor: '20', has_more: 1 }] });
        const third = await api.listDouyinComments(thirdPage.page, '123', { limit: 3, cursor: next.cursor });
        expect(third.items.map(item => item.comment_id)).toEqual(['c3', 'c4', 'c5']);
        expect(thirdPage.requests[0].searchParams.get('count')).toBe('20');
    });
    it('rejects an insufficient replay page instead of discarding its outstanding resume cursor', async () => {
        const cursor = 'bycli:' + encodeURIComponent(JSON.stringify({ cursor: '0', skip: 4, count: 20 }));
        const { page } = makePage({ responses: [{ status_code: 0, comments: [{ cid: 'c1', text: '1' }], cursor: '1', has_more: 1 }] });
        await expect(api.listDouyinComments(page, '123', { limit: 1, cursor })).rejects.toThrow(/resume|prefix/i);
    });
    it('rejects unsafe numeric reply identifiers while preserving precise string comment IDs', async () => {
        const unsafe = makePage();
        await expect(api.listDouyinComments(unsafe.page, '123', { comment_id: 7654321098765432109 })).rejects.toThrow(/string|precision/i);
        expect(unsafe.requests).toHaveLength(0);
        const precise = makePage({ responses: [{ status_code: 0, comments: [], cursor: '0', has_more: 0 }] });
        await api.listDouyinComments(precise.page, '123', { comment_id: '7654321098765432109' });
        expect(precise.requests[0].searchParams.get('comment_id')).toBe('7654321098765432109');
    });
    it('uses smaller native first pages without imposing replay capacity on ordinary requests', async () => {
        const { page, requests } = makePage({ captures: [{ url: 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=123&cursor=0&count=1', responsePreview: JSON.stringify({ status_code: 0, comments: [{ cid: 'c1', text: '1' }], cursor: '1', has_more: 0 }) }] });
        expect((await api.listDouyinComments(page, '123', { limit: 20 })).items.map(item => item.comment_id)).toEqual(['c1']);
        expect(requests).toHaveLength(0);
    });
    it.each(['user', 'search'])('keeps %s replay resumable when smaller native pages and React samples coexist', async kind => {
        const works = Array.from({ length: 20 }, (_, index) => video(String(index + 1)));
        const path = kind === 'user' ? '/aweme/v1/web/aweme/post/?sec_user_id=MS4w-author&max_cursor=0' : '/aweme/v1/web/general/search/single/?keyword=cats&offset=0';
        const body = (items, next) => kind === 'user' ? { status_code: 0, aweme_list: items, max_cursor: next, has_more: 1 } : { status_code: 0, data: items.map(aweme_info => ({ aweme_info })), cursor: next, has_more: 1 };
        const acquire = (page, options) => kind === 'user' ? api.listDouyinUserWorks(page, 'MS4w-author', options) : api.searchDouyinWorks(page, 'cats', options);
        const firstPage = makePage({ captures: [{ url: 'https://www.douyin.com' + path + '&count=20', responsePreview: JSON.stringify(body(works, '20')) }] });
        const first = await acquire(firstPage.page, { limit: 1 });
        const nextPage = makePage({ state: { cards: works.slice(0, 2) }, captures: [{ url: 'https://www.douyin.com' + path + '&count=2', responsePreview: JSON.stringify(body(works.slice(0, 2), '2')) }], responses: [body(works, '20')] });
        const next = await acquire(nextPage.page, { limit: 1, cursor: first.cursor });
        expect(next.items.map(item => item.aweme_id)).toEqual(['2']);
        expect(next.cursor).toMatch(/^bycli:/);
        expect(next).toMatchObject({ has_more: true, truncated: true, limitation: 'limit' });
        expect(nextPage.requests[0].searchParams.get('count')).toBe('20');
    });
    it.each([null, undefined, '', 2, 'false', {}, []].map(flag => [flag]))('discloses unknown pagination flags without claiming feed exhaustion (%j)', async flag => {
        const { page } = makePage({ responses: [{ status_code: 0, aweme_list: [video('1')], max_cursor: '5', has_more: flag }] });
        expect(await api.listDouyinUserWorks(page, 'MS4w-user')).toMatchObject({ has_more: true, truncated: true, limitation: 'pagination_unknown' });
    });
    it.each([false, 0, '0'])('recognizes only explicit exhausted pagination flags (%j)', async flag => {
        const { page } = makePage({ responses: [{ status_code: 0, aweme_list: [video('1')], max_cursor: '5', has_more: flag }] });
        expect(await api.listDouyinUserWorks(page, 'MS4w-user')).toMatchObject({ cursor: '5', has_more: false, truncated: false });
    });
    it.each([[undefined, 'missing_cursor'], ['0', 'repeated_cursor']])('does not expose stale next cursors at the exact limit boundary (%s)', async (cursor, limitation) => {
        const { page } = makePage({ responses: [{ status_code: 0, comments: [{ cid: '12', reply_id: '10', text: 'reply' }], cursor, has_more: 1 }] });
        expect(await api.listDouyinComments(page, '123', { comment_id: '10', limit: 1, cursor: '0' })).toMatchObject({ cursor: null, has_more: true, truncated: true, limitation });
    });
    it('retains safe within-page replay when the server next cursor is missing', async () => {
        const response = { status_code: 0, comments: [{ cid: '1', text: 'a' }, { cid: '2', text: 'b' }], has_more: 1 };
        const first = await api.listDouyinComments(makePage({ responses: [response] }).page, '123', { limit: 1 });
        expect(first.cursor).toMatch(/^bycli:/);
        const second = await api.listDouyinComments(makePage({ responses: [response] }).page, '123', { limit: 1, cursor: first.cursor });
        expect(second.items.map(item => item.comment_id)).toEqual(['2']);
        expect(second).toMatchObject({ cursor: null, has_more: true, truncated: true, limitation: 'missing_cursor' });
    });
    it('preserves precise reply parents for inline and standalone reply rows', async () => {
        const parent = '7654321098765432109';
        const inline = await api.listDouyinComments(makePage({ responses: [
            { status_code: 0, comments: [{ cid: parent, text: 'root', reply_comment_total: 1 }], cursor: '1', has_more: 0 },
            { status_code: 0, comments: [{ cid: '12', reply_id: parent, reply_to_reply_id: '7654321098765432110', text: 'reply' }], cursor: '1', has_more: 0 },
        ] }).page, '123', { limit: 1, replies: 1 });
        expect(inline.items[0]).toMatchObject({ parent_comment_id: null, replies: [{ comment_id: '12', parent_comment_id: parent, reply_to_comment_id: '7654321098765432110' }] });
        const standalone = await api.listDouyinComments(makePage({ responses: [{ status_code: 0, comments: [{ cid: '13', text: 'reply without upstream parent' }], cursor: '1', has_more: 0 }] }).page, '123', { limit: 1, comment_id: parent });
        expect(standalone.items[0]).toMatchObject({ comment_id: '13', parent_comment_id: parent });
        const supplied = await api.listDouyinComments(makePage({ responses: [{ status_code: 0, comments: [{ cid: '14', reply_id: parent, text: 'reply with upstream parent' }], cursor: '1', has_more: 0 }] }).page, '123', { limit: 1 });
        expect(supplied.items[0].parent_comment_id).toBe(parent);
    });
    it.each(['reply_id', 'reply_to_reply_id'])('rejects unsafe numeric upstream reply references (%s)', async key => {
        const { page } = makePage({ responses: [{ status_code: 0, comments: [{ cid: '12', [key]: 7654321098765432109, text: 'reply' }], cursor: '1', has_more: 0 }] });
        await expect(api.listDouyinComments(page, '123', { limit: 1, comment_id: '10' })).rejects.toThrow(/precision|precise|string/i);
    });
    it('surfaces auth and malformed responses without reporting empty success', async () => {
        await expect(api.listDouyinUserWorks(makePage({ responses: [{ status_code: 8, status_msg: 'login required' }] }).page, 'MS4w-user')).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(api.listDouyinComments(makePage({ responses: [{ status_code: 0, comments: 'bad' }] }).page, '123')).rejects.toBeInstanceOf(CommandExecutionError);
        await expect(api.searchDouyinWorks(makePage({ responses: [{ status_code: 0, data: {} }] }).page, 'x')).rejects.toBeInstanceOf(CommandExecutionError);
    });
});
