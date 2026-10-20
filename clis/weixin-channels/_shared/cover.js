import { ArgumentError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function localCover(value, flag = 'cover') {
  if (typeof value !== 'string' || !/\.(png|jpe?g)$/i.test(value)) throw new ArgumentError(`--${flag} must be a local PNG or JPEG image`);
  const path = resolve(value);
  let info, bytes;
  try { info = await stat(path); if (info.isFile()) bytes = await readFile(path); } catch { /* Return a stable input error. */ }
  if (!bytes?.length) throw new ArgumentError('Cover image must be a nonempty local file');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new ArgumentError('Cover contents must be PNG or JPEG');
  return { path, bytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// Each native card editor transcodes its own selected source. Track complete
// resource identities independently, never a URL prefix.
export function coverSources(cover) {
  return cover?.sources ?? (cover?.path ? { horizontal: cover } : {});
}
export async function requestedCovers(args) {
  const sources = {};
  for (const [role, flag] of [['horizontal', 'cover'], ['vertical', 'vertical-cover']]) {
    if (args[flag] !== undefined) sources[role] = await localCover(args[flag], flag);
  }
  return Object.keys(sources).length ? { sources, phase: 'pending' } : undefined;
}
export async function coverDOM(action, operationId, role = 'horizontal') {
  if (!['horizontal', 'vertical'].includes(role)) return { error: 'invalid_cover_role' };
  if (location.origin !== 'https://channels.weixin.qq.com' || location.pathname !== '/platform/post/create'
    || document.documentElement.getAttribute('data-bycli-channels-operation') !== operationId) return { error: 'wrong_bound_editor' };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const visible = el => {
    for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
      const style = getComputedStyle(n);
      if (n.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const text = roots.flatMap(r => [...r.querySelectorAll('*')]).filter(e => !e.children.length && visible(e)).map(e => e.textContent.trim()).join('\n');
  if (/验证码|安全验证|扫码验证|管理员本人验证/.test(text)) return { error: 'verification_required' };
  const wraps = roots.flatMap(r => [...r.querySelectorAll('.cover-preview-wrap')]).filter(visible);
  if (wraps.length !== 1) return { error: 'cover_editor_loading' };
  const root = wraps[0].getRootNode();
  if (action === 'position') {
    const card = wraps[0].querySelector(role === 'vertical' ? '.vertical-cover-wrap' : '.horizon-cover-wrap');
    card?.scrollIntoView?.({ block: 'center', inline: 'center' });
    return { positioned: !!card };
  }
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(n => n.toString(16).padStart(2, '0')).join('');
  const cards = {};
  for (const [name, selector] of [['vertical', '.vertical-cover-wrap img.vertical-img-size'], ['horizontal', '.horizon-cover-wrap img.horizon-img-size']]) {
    const imgs = [...wraps[0].querySelectorAll(selector)];
    if (imgs.length !== 1 || !imgs[0].complete || !imgs[0].naturalWidth) continue;
    const url = new URL(imgs[0].currentSrc || imgs[0].src);
    if (url.protocol !== 'https:' || !/(^|\.)video\.qq\.com$/.test(url.hostname)) continue;
    // encfilekey and idx identify the resource. token is transient authorization;
    // rendition/transport parameters may be rewritten on native draft reload.
    if (!url.searchParams.get('encfilekey')) continue;
    const identity = JSON.stringify([url.origin, url.pathname, url.searchParams.get('encfilekey'), url.searchParams.get('idx')]);
    cards[name] = await hash(new TextEncoder().encode(identity));
  }
  const dialogs = [...root.querySelectorAll('.weui-desktop-dialog')].filter(visible);
  const edit = dialogs.filter(d => /^编辑(分享|个人主页)卡片$/.test(d.querySelector('h3')?.textContent.trim() || ''));
  const crop = dialogs.filter(d => d.querySelector('h3')?.textContent.trim() === '裁剪封面图');
  let thumb = null, previewReady = false;
  if (edit.length === 1) {
    const imgs = [...edit[0].querySelectorAll('.single-cover-uploader-wrap img.img-wrap')];
    if (imgs.length === 1 && imgs[0].complete && imgs[0].naturalWidth && /^data:image\/(png|jpeg);base64,/.test(imgs[0].src)) {
      thumb = await hash(Uint8Array.from(atob(imgs[0].src.split(',')[1]), c => c.charCodeAt(0)));
    }
    previewReady = [...edit[0].querySelectorAll('.preview-item img')].some(e => visible(e) && e.complete && e.naturalWidth > 0);
  }
  let selector = null, point = null;
  const mark = elements => {
    if (elements.length !== 1) return null;
    for (const el of root.querySelectorAll('[data-bycli-channels-cover]')) el.removeAttribute('data-bycli-channels-cover');
    elements[0].setAttribute('data-bycli-channels-cover', action);
    if (action === 'confirm' || action === 'crop') elements[0].scrollIntoView?.({ block: 'center', inline: 'center' });
    if (['open', 'confirm', 'crop'].includes(action)) {
      const rect = elements[0].getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight) point = { x, y };
    }
    return `[data-bycli-channels-cover="${action}"]`;
  };
  const roleTitle = role === 'vertical' ? '编辑个人主页卡片' : '编辑分享卡片';
  if (edit.length === 1 && edit[0].querySelector('h3')?.textContent.trim() !== roleTitle && action !== 'status') return { error: 'wrong_cover_dialog' };
  if (action === 'open' && !edit.length && !crop.length) {
    // The edit strip is the native hit area at the bottom of each card.
    // Hover may expose a recommendation; choose “直接编辑”, never “使用素材”.
    const direct = [...root.querySelectorAll('.img-recommend-wrap .btn-directly-edit button')].filter(e => visible(e) && e.textContent.trim() === '直接编辑' && !e.disabled);
    if (direct.length) selector = mark(direct);
    else selector = mark([...wraps[0].querySelectorAll(role === 'vertical' ? '.vertical-img-wrap .edit-btn' : '.horizon-img-wrap .edit-btn')].filter(visible));
  }
  if (action === 'upload' && edit.length === 1 && !crop.length) selector = mark([...edit[0].querySelectorAll('.single-cover-uploader-wrap > input[type="file"]')].filter(e => /image/.test(e.accept)));
  if (action === 'crop' && crop.length === 1 && [...crop[0].querySelectorAll('canvas.cr-image')].some(e => e.width > 0 && e.height > 0)) {
    selector = mark([...crop[0].querySelectorAll('button')].filter(e => visible(e) && e.textContent.trim() === '确定' && !e.disabled));
  }
  if (action === 'confirm' && edit.length === 1 && !crop.length && thumb && previewReady) {
    selector = mark([...edit[0].querySelectorAll('.cover-set-footer button')].filter(e => visible(e) && e.textContent.trim() === '确认' && !e.disabled && !/disabled/.test(e.className)));
  }
  return { cards, thumb, previewReady, dialog: edit.length === 1, cropping: crop.length === 1, selector, point };
}

export const coverScript = (action, id, role = 'horizontal') => `(${coverDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(id)},${JSON.stringify(role)})`;
export async function coverState(page, op, action = 'status', role = 'horizontal') {
  const state = await page.evaluate(coverScript(action, op.operation_id, role));
  if (!state || state.error) throw new CommandExecutionError(`Cover editor unavailable: ${state?.error || 'invalid response'}`);
  return state;
}
export function sameCovers(expected, actual) {
  const keys = Object.keys(expected ?? {});
  return keys.length > 0 && keys.every(k => ['vertical', 'horizontal'].includes(k) && typeof expected[k] === 'string' && expected[k] === actual?.[k]);
}
export async function verifyCover(page, op, allowLoading = false) {
  if (!op.cover) return;
  const state = await coverState(page, op);
  if (allowLoading && !state.dialog && !state.cropping && Object.keys(coverSources(op.cover)).some(k => !state.cards[k])) return false;
  if (state.dialog || state.cropping || !Object.keys(coverSources(op.cover)).every(k => op.cover.identities?.[k]) || !sameCovers(op.cover.identities, state.cards)) throw new CommandExecutionError('Saved custom cover identities changed or are not loaded; refusing publication');
}

export async function configureCover(page, op, persist, timeout) {
  if (!op.cover) return;
  const sources = coverSources(op.cover);
  for (const source of Object.values(sources)) if ((await localCover(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('Recorded cover file changed; refusing upload');
  if (op.cover.phase === 'configured') { await verifyCover(page, op); return; }
  // An interrupted upload/confirmation is retained for inspection, never retried.
  if (op.cover.phase && op.cover.phase !== 'pending') throw new CommandExecutionError('Custom cover update was interrupted; inspect the retained editor before continuing, do not upload again automatically');
  const initial = await coverState(page, op);
  op.cover.originalIdentities ??= initial.cards;
  op.cover.completedRoles ??= {};
  for (const role of Object.keys(sources)) {
    if (op.cover.completedRoles[role]) {
      if ((await coverState(page, op)).cards[role] !== op.cover.completedRoles[role]) throw new CommandExecutionError('Partially configured cover changed; inspect it before recovery');
      continue;
    }
    await configureRole(page, op, persist, timeout, role);
  }
  const final = await coverState(page, op);
  if (!Object.keys(sources).every(k => final.cards[k] && final.cards[k] !== op.cover.originalIdentities[k])) throw new CommandExecutionError('Each requested card cover must use its uploaded image before saving');
  for (const role of ['horizontal', 'vertical']) if (!sources[role] && final.cards[role] !== op.cover.originalIdentities[role]) throw new CommandExecutionError('Unrequested default cover changed; inspect it before saving');
  op.cover.phase = 'configured'; op.cover.identities = Object.fromEntries(Object.keys(sources).map(k => [k, final.cards[k]])); await persist();
}

async function configureRole(page, op, persist, timeout, role) {
  const deadline = Date.now() + timeout * 1000;
  let state;
  while (Date.now() < deadline) {
    await page.focusWindow?.(); await page.wait({ time: 1 });
    await coverState(page, op, 'position', role); await page.wait(0.15);
    await page.wait({ time: 1 });
    state = await coverState(page, op, 'open', role);
    if (state.selector) break;
    await page.wait(0.5);
  }
  if (!state?.selector) throw new TimeoutError('Native cover edit control', timeout);
  op.cover.phase = 'opening'; op.cover.role = role; await persist(); await page.wait(0.15); await clickCoverControl(page, state); await page.wait({ time: 1 });
  state = null;
  let nextOpenAt = Date.now() + 3000;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'upload', role);
    if (state.selector) break;
    // Hover overlays can consume the first pointer click. Reopen only while
    // there is observably no dialog; file upload/confirmation are never retried.
    if (!state.dialog && !state.cropping && Date.now() >= nextOpenAt) {
      nextOpenAt = Date.now() + 3000;
      await page.focusWindow?.(); await page.wait({ time: 1 });
      const open = await coverState(page, op, 'open', role);
      if (open.selector) { await page.wait(0.15); await clickCoverControl(page, open); await page.wait({ time: 1 }); }
    }
    await page.wait(0.25);
  }
  if (!state?.selector) throw new TimeoutError('Native cover file input', timeout);
  const before = state.cards[role];
  op.cover.phase = 'upload_unknown'; await persist();
  await page.uploadFiles(state.selector, [coverSources(op.cover)[role].path]);
  state = null;
  let cropClicked = false;
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'confirm', role);
    if (state.cropping && !cropClicked) {
      const crop = await coverState(page, op, 'crop', role);
      if (crop.selector) { cropClicked = true; await clickCoverControl(page, crop); }
    }
    if (state.selector && state.thumb) break;
    await page.wait(0.25);
  }
  if (!state?.selector || !state.thumb) throw new TimeoutError('Uploaded cover preview', timeout);
  op.cover.phase = 'confirm_unknown'; await persist(); await clickCoverControl(page, state);
  while (Date.now() < deadline) {
    state = await coverState(page, op, 'status', role);
    if (!state.dialog && !state.cropping && state.cards[role] && state.cards[role] !== before) {
      op.cover.completedRoles[role] = state.cards[role]; op.cover.phase = 'pending'; await persist(); return;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Custom cover card image', timeout);
}

async function clickCoverControl(page, state) {
  // Let focus and modal scrolling settle before dispatching native pointer input.
  await page.focusWindow?.(); await page.wait({ time: 1 });
  await page.hover?.(state.selector); await page.wait(0.5);
  if (state.point && page.nativeClick) await page.nativeClick(state.point.x, state.point.y);
  else await page.click(state.selector);
  await page.wait({ time: 1 });
}
