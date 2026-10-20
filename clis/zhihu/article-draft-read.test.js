import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { articleDraftDOM, articlePersisted } from './_shared/article-draft-read.js';
// Synthetic minimum of the observed editor response, not a captured fixture.
const id = '2095573614057866302';
const op = { draft_id: id, author_identity: 'alice', title: '标题', body: '第一段\n\n第二段', image_count: 2,
    image_keys: ['v2-aabbcc', 'v2-ddeeff'], cover_key: 'v2-aabbcc' };
function fixture() {
    const d = new JSDOM('', { url: `https://zhuanlan.zhihu.com/p/${id}/edit`, runScripts: 'outside-only' });
    const data = { id, state: 'draft', title: '标题', author: { url_token: 'alice' }, title_image: 'https://pic.zhimg.com/v2-aabbcc_1440w.png',
        content: '<p>第一段<br><br>第二段</p><figure><img src="https://pic.zhimg.com/v2-aabbcc_720w.png"><figcaption>图片注释</figcaption></figure><figure><img src="https://pic.zhimg.com/v2-ddeeff.png"></figure>' };
    d.window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => data }));
    return { d, data, page: { evaluate: js => d.window.eval(js) } };
}
describe('persisted article readback', () => {
    it('checks exact owner, draft state, body, ordered resource ids and cover independently of UI saving badge', async () => {
        const { d, page } = fixture(); expect(await articlePersisted(page, op)).toBe(true); d.window.close();
    });
    it.each(['owner', 'state', 'id'])('rejects wrong %s before submission', async field => {
        const { d, data, page } = fixture();
        if (field === 'owner') data.author.url_token = 'bob';
        if (field === 'state') data.state = 'published';
        if (field === 'id') data.id = Number(id);
        await expect(articlePersisted(page, op)).rejects.toThrow('identity/account/state'); d.window.close();
    });
    it('does not accept a changed body or reversed images as persisted', async () => {
        const { d, page } = fixture(); expect(await articlePersisted(page, { ...op, body: '其他正文' })).toBe(false);
        expect(await articlePersisted(page, { ...op, image_keys: [...op.image_keys].reverse() })).toBe(false); d.window.close();
    });
    it('never reads a draft from another page identity', async () => {
        const { d } = fixture(); d.reconfigure({ url: 'https://zhuanlan.zhihu.com/p/1/edit' });
        expect(await d.window.eval(`(${articleDraftDOM.toString()})(${JSON.stringify(id)})`)).toEqual({ status: 0 });
        expect(d.window.fetch).not.toHaveBeenCalled(); d.window.close();
    });
});

it('does not mark a requested but unidentified cover as verified', async () => {
    const page = { evaluate: vi.fn() };
    expect(await articlePersisted(page, { ...op, cover: { path: './cover.png' }, cover_key: null })).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
});
