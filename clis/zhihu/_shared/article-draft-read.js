import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { normalizeDraftText } from '../draft-shared.js';
// Actual editor GET endpoint observed on 2026-10-19. No HTTP write fallback.
export async function articleDraftDOM(id) {
    if (location.origin !== 'https://zhuanlan.zhihu.com' || location.pathname !== `/p/${id}/edit`) return { status: 0 };
    const response = await fetch(`/api/articles/${id}/draft`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return { status: response.status };
    const value = await response.json();
    const key = src => { try { return new URL(src, location.href).pathname.match(/v2-[a-f0-9]+/i)?.[0] || new URL(src, location.href).pathname; } catch { return null; } };
    const doc = new DOMParser().parseFromString(value.content || '', 'text/html');
    const images = [...doc.querySelectorAll('img')].map(n => key(n.getAttribute('src')));
    for (const n of doc.querySelectorAll('figure,figcaption')) n.remove();
    for (const n of doc.querySelectorAll('br')) n.replaceWith(doc.createTextNode('\n'));
    for (const n of doc.querySelectorAll('p')) n.append(doc.createTextNode('\n'));
    return { status: response.status, id: value.id, state: value.state, title: value.title, owner: value.author?.url_token,
        body: doc.body.textContent, image_keys: images, cover_key: value.title_image ? key(value.title_image) : null };
}
export async function articlePersisted(page, op) {
    if (op.cover && !op.cover_key) return false;
    let s;
    try { s = await page.evaluate(`(${articleDraftDOM.toString()})(${JSON.stringify(op.draft_id)})`); }
    catch { throw new CommandExecutionError('Could not read the persisted article draft'); }
    if (s?.status === 401) throw new AuthRequiredError('zhuanlan.zhihu.com');
    if (s?.status !== 200 || s.id !== op.draft_id || s.state !== 'draft' || s.owner !== op.author_identity) throw new CommandExecutionError('Persisted article draft identity/account/state does not match this operation');
    const key = value => value?.match(/v2-[a-f0-9]+/i)?.[0] || value;
    return s.title === op.title && normalizeDraftText(s.body) === normalizeDraftText(op.body)
        && Array.isArray(s.image_keys) && s.image_keys.length === op.image_count
        && (!op.image_keys || JSON.stringify(s.image_keys.map(key)) === JSON.stringify(op.image_keys.map(key)))
        && (!op.cover_key || key(s.cover_key) === key(op.cover_key));
}
