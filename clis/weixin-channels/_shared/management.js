import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { POST_COUNTER_FIELDS } from './model.js';
import { randomUUID } from 'node:crypto';

// Observed on the authenticated management list on 2026-10-19. Read only the
// rendered card's backing fields; never return media URLs or account credentials.
export function managementPostScript(id) {
  return `(() => {
    if (location.origin !== 'https://channels.weixin.qq.com') return {error:'wrong_origin'};
    if (/\\/login(?:\\.|\\/|$)/.test(location.pathname)) return {error:'login_required'};
    if (location.pathname !== '/platform/post/list') return {error:'wrong_list_path'};
    const roots = [document];
    for (let i=0;i<roots.length;i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    const matches = roots.flatMap(r => [...r.querySelectorAll('.post-feed-item')])
      .map(el => el.__vue__?.$props?.post).filter(p => p?.objectId === ${JSON.stringify(id)});
    if (matches.length !== 1) return {matches:matches.length};
    const p=matches[0];
    const record = {objectId:p.objectId,createTime:p.createTime,desc:{description:p.desc?.description},status:p.status};
    for (const field of ${JSON.stringify([...POST_COUNTER_FIELDS, 'fullPlayRate', 'avgPlayTimeSec'])}) if (p[field] !== undefined) record[field]=p[field];
    return {matches:1,record};
  })()`;
}

export async function fetchManagementPost(page, id) {
  await page.goto(`https://channels.weixin.qq.com/platform/post/list?bycli_management=${randomUUID()}`, { stealth: false });
  let previous;
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = await page.evaluate(managementPostScript(id));
    if (value?.error === 'login_required') throw new AuthRequiredError('channels.weixin.qq.com');
    if (!value || value.error) throw new CommandExecutionError(`Management list unavailable: ${value?.error || 'invalid state'}`);
    // Publication may briefly insert an optimistic duplicate. Wait for two
    // consecutive identical, uniquely identified card reads before accepting it.
    const fingerprint = value.matches === 1 ? JSON.stringify(value.record) : null;
    if (fingerprint && fingerprint === previous) return value.record;
    previous = fingerprint;
    await page.wait(0.5);
  }
  throw new EmptyResultError('weixin-channels management status', 'Exact management ID did not stabilize as one current-account record');
}
