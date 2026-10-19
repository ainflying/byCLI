import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError, EmptyResultError } from '@sovovs/bycli/errors';
import { open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { publishScript, previewFingerprintDOM } from './publish-dom.js';
import { fetchPosts, fetchPostDetail } from './client.js';
import { normalizePost, normalizeDetail, resolveDateRange } from './model.js';
import { fetchManagementPost } from './management.js';

const CREATE_URL = 'https://channels.weixin.qq.com/platform/post/create';
export const PUBLISH_COLUMNS = ['operation_id', 'status', 'submitted', 'id', 'management_id', 'metrics_source', 'editor_url', 'public_url', 'description', 'ai_generated', 'message', 'metrics', 'analytics', 'editor'];

export function validatePublishArgs(args) {
  if (!args.execute) throw new ArgumentError('Use --execute to prepare or submit a video');
  if (!args.operation || typeof args.operation !== 'string') throw new ArgumentError('--operation must be a local journal path');
  if (!['prepare', 'adopt-draft', 'retry-upload', 'recover', 'resume', 'submit'].includes(args.mode ?? 'prepare')) throw new ArgumentError('--mode must be prepare, adopt-draft, retry-upload, recover, resume or submit');
  if (args.mode === 'recover' && !/^[a-f0-9]{32}$/i.test(args['editor-page'] || '')) throw new ArgumentError('Explicit recovery requires the inspected editor page ID');
  if (args.mode === 'recover' && !/^[\w-]{1,100}$/.test(args['editor-session'] || '')) throw new ArgumentError('Recovery requires an explicitly bound browser session');
  if (!['adopt-draft', 'recover', 'retry-upload'].includes(args.mode) && (args['editor-page'] !== undefined || args['editor-session'] !== undefined)) throw new ArgumentError('Editor binding is only valid with adopt-draft, recover or retry-upload');
  if (args.mode === 'adopt-draft' && (!/^export\/[\w-]+$/.test(args['draft-id'] || '') || !/^[a-f0-9]{32}$/i.test(args['editor-page'] || '')
    || !/^[\w-]{1,100}$/.test(args['editor-session'] || '') || !args.description?.trim() || !['yes', 'no'].includes(args['ai-generated']))) throw new ArgumentError('Draft adoption requires its exact draft ID, inspected bound editor, description and AI choice');
  if (args.mode === 'retry-upload' && (args['editor-page'] !== undefined || args['editor-session'] !== undefined)
    && (!/^[a-f0-9]{32}$/i.test(args['editor-page'] || '') || !/^[\w-]{1,100}$/.test(args['editor-session'] || ''))) throw new ArgumentError('Upload retry binding requires both inspected page ID and bound browser session');
  const timeout = args.timeout ?? 180;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800) throw new ArgumentError('--timeout must be 1–1800 seconds');
  if ((args.mode ?? 'prepare') === 'prepare') {
    if (typeof args.file !== 'string' || !args.file) throw new ArgumentError('A local video file is required');
    if (typeof args.description !== 'string' || !args.description.trim()) throw new ArgumentError('--description is required');
    if (!['yes', 'no'].includes(args['ai-generated'])) throw new ArgumentError('--ai-generated must explicitly be yes or no');
  }
  if (args.mode === 'retry-upload' && (typeof args.file !== 'string' || !args.file)) throw new ArgumentError('Explicit retry-upload requires the original local video file');
}

export async function readOperation(file) {
  let op;
  try { op = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new ArgumentError('Invalid operation journal'); }
  if (op.version !== 1 || typeof op.operation_id !== 'string' || typeof op.description !== 'string'
    || !['yes', 'no'].includes(op.ai_generated) || typeof op.submitted !== 'boolean'
    || !Number.isFinite(Date.parse(op.created_at)) || typeof op.status !== 'string') throw new ArgumentError('Invalid operation journal schema');
  return op;
}
async function save(file, op) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(op, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}
function result(op, editor = null) {
  return [{ operation_id: op.operation_id, status: op.status, submitted: op.submitted, id: op.id ?? null,
    management_id: op.management_id ?? null, metrics_source: op.metrics_source ?? null,
    editor_url: op.editor_url ?? CREATE_URL, public_url: null, description: op.description, ai_generated: op.ai_generated,
    message: op.message ?? '', metrics: op.metrics ?? null, analytics: op.analytics ?? null, editor }];
}
async function inspect(page, action, op) {
  const s = await page.evaluate(publishScript(action, op.operation_id, op.ai_generated));
  if (s?.error === 'login_required') throw new AuthRequiredError('channels.weixin.qq.com');
  if (!s || s.error) throw new CommandExecutionError(`Video editor unavailable: ${s?.error || 'invalid state'}`);
  return s;
}
async function locked(file, fn) {
  let lock;
  try { lock = await open(`${file}.lock`, 'wx', 0o600); }
  catch (e) { throw new CommandExecutionError(e.code === 'EEXIST' ? 'Operation is already running; do not repeat submission' : 'Cannot create operation lock'); }
  try { return await fn(); }
  finally { await lock.close(); await unlink(`${file}.lock`); }
}

export async function publishVideo(page, args) {
  validatePublishArgs(args);
  const file = resolve(args.operation);
  return locked(file, async () => {
    let op = await readOperation(file);
    const mode = args.mode ?? 'prepare';
    if (mode === 'adopt-draft') {
      if (op) return result({ ...op, message: 'Existing operation retained; no draft was adopted or submitted again' });
      const pending = { version: 1, operation_id: randomUUID(), created_at: new Date().toISOString(),
        description: args.description, ai_generated: args['ai-generated'], submitted: false, status: 'prepared',
        source: 'platform_draft', source_draft_id: args['draft-id'], target: args['editor-page'], editor_session: args['editor-session'] };
      page.setActivePage(pending.target);
      let state = await inspect(page, 'status', pending);
      if (state.draft_id !== pending.source_draft_id || state.description !== pending.description || state.blocked || !state.ready || state.cover_pending) throw new CommandExecutionError('Exact saved draft, description, preview or cover is not ready; refusing adoption');
      // The platform can drop this declaration when reopening a saved draft.
      // Restore only the explicitly supplied choice through its scoped control.
      for (let n = 0; n < 12 && !state.ai_selected; n++) {
        const control = await inspect(page, 'ai', pending);
        if (control.blocked || control.draft_id !== pending.source_draft_id || control.description !== pending.description) throw new CommandExecutionError('Saved draft changed while restoring its declaration');
        if (control.selector) await page.click(control.selector);
        await page.wait(0.25); state = await inspect(page, 'status', pending);
      }
      if (!state.can_submit) throw new CommandExecutionError('Saved draft AI label or publish control is not ready; refusing adoption');
      await inspect(page, 'bind', pending);
      pending.editor_url = state.url;
      pending.message = 'Exact existing platform draft verified and retained; no upload, content change or submission';
      await save(file, pending); return result(pending);
    }
    if (mode === 'prepare' || mode === 'retry-upload' || mode === 'recover' || mode === 'resume') {
      let state;
      if (mode === 'recover') {
        if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status)) throw new CommandExecutionError('Only an unsubmitted interrupted preparation can be recovered');
        page.setActivePage(args['editor-page']);
        state = await inspect(page, 'status', op);
        if (state.blocked || !state.ready || state.description && state.description !== op.description) throw new CommandExecutionError('Recovered editor is unavailable or contains different content');
        const fingerprint = await page.evaluate(`(${previewFingerprintDOM.toString()})()`);
        if (fingerprint?.sha256 !== op.sha256) throw new CommandExecutionError(`Recovered video identity was not verified: ${fingerprint?.error || 'hash_mismatch'}`);
        await inspect(page, 'bind', op);
        op.recoveries = [...(op.recoveries || []), { at: new Date().toISOString(), previous_target: op.target, target: args['editor-page'], sha256: fingerprint.sha256 }];
        op.target = args['editor-page']; op.editor_session = args['editor-session']; await save(file, op);
      } else if (mode !== 'resume') {
        // A retained journal is never permission to upload again.
        if (op && mode === 'prepare') return result({ ...op, message: 'Existing operation retained; inspect its status instead of uploading again' });
        if (mode === 'retry-upload') {
          if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status) || !op.target) throw new CommandExecutionError('Explicit upload retry requires an unsubmitted interrupted operation');
          page.setActivePage(args['editor-page'] || op.target);
          state = await inspect(page, 'status', op);
          if (state.blocked || state.ready || state.input_files.length || state.videos.length || state.description?.trim()) throw new CommandExecutionError('Original editor must be empty after reopening; refusing to overwrite an uploaded preview or other content');
        }
        const media = resolve(args.file);
        let info;
        try { info = await stat(media); } catch { throw new ArgumentError('Video file not found'); }
        if (!info.isFile() || info.size === 0) throw new ArgumentError('Video must be a nonempty local file');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(media)) hash.update(chunk);
        const sha256 = hash.digest('hex');
        if (mode === 'retry-upload') {
          if (op.sha256 !== sha256) throw new CommandExecutionError('Original video hash changed; refusing upload retry');
          op.upload_retries = [...(op.upload_retries || []), { at: new Date().toISOString(), previous_status: op.status }];
          if (args['editor-page']) {
            op.rebindings = [...(op.rebindings || []), { at: new Date().toISOString(), previous_target: op.target, target: args['editor-page'] }];
            op.target = args['editor-page']; op.editor_session = args['editor-session'];
          }
          op.status = 'preparing'; op.file_selected = false; op.description_filled = false;
        } else op = { version: 1, operation_id: randomUUID(), created_at: new Date().toISOString(),
          description: args.description, ai_generated: args['ai-generated'], sha256,
          status: 'preparing', submitted: false };
        await save(file, op);
        if (mode === 'prepare') await page.goto(CREATE_URL, { stealth: false });
        op.target = page.getActivePage?.();
        if (!op.target) throw new CommandExecutionError('Browser page identity is required');
        if (!op.editor_session) await page.focusWindow?.();
        await save(file, op);
        const loadDeadline = Date.now() + (args.timeout ?? 180) * 1000;
        do {
          state = await page.evaluate(publishScript('bind', op.operation_id, op.ai_generated));
          if (state?.error !== 'editor_loading') break;
          await page.wait(0.5);
        } while (Date.now() < loadDeadline);
        if (state?.error === 'login_required') throw new AuthRequiredError('channels.weixin.qq.com');
        if (!state || state.error) throw new CommandExecutionError('Video editor did not become available');
        op.editor_url = state.url;
        if (state.blocked) { op.status = 'requires_user_action'; op.message = 'Inspect login, verification or account permissions'; await save(file, op); return result(op); }
        const input = await inspect(page, 'input', op);
        if (!input.selector) throw new CommandExecutionError('Unique video upload control not found');
        await page.uploadFiles(input.selector, [media]);
        op.file_selected = true;
        await save(file, op);
      } else {
        // Explicit recovery only: preserve the uploaded video and the original tab.
        if (!op || op.submitted || !['preparing', 'preparation_unknown'].includes(op.status)) {
          throw new CommandExecutionError('Only an unsubmitted interrupted preparation can be resumed');
        }
        if (!op.target || typeof page.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
        page.setActivePage(op.target);
        if (!op.editor_session) await page.focusWindow?.();
        state = await inspect(page, 'status', op);
        if (state.operation_id !== op.operation_id || !state.ready || (state.description && state.description !== op.description)) {
          throw new CommandExecutionError('Original uploaded preview is unavailable or the retained page changed; refusing recovery');
        }
      }
      const deadline = Date.now() + (args.timeout ?? 180) * 1000;
      let filled = false;
      while (Date.now() < deadline) {
        state = await inspect(page, filled ? 'ai' : 'editor', op);
        if (state.blocked) break;
        if (!filled && state.selector) {
          const written = await page.fillText(state.selector, op.description);
          if (!written?.verified) throw new CommandExecutionError('Description input was not verified; inspect the retained page');
          filled = true;
          op.description_filled = true;
          await save(file, op);
        }
        else if (filled && !state.ai_selected && state.selector) await page.click(state.selector);
        if (filled && state.can_submit && state.description === op.description && state.ai_selected) {
          op.status = 'prepared'; op.message = 'Video ready in retained tab; not saved as a platform draft and not submitted';
          await save(file, op); return result(op);
        }
        await page.wait(0.5);
      }
      op.status = state.blocked ? 'requires_user_action' : 'preparation_unknown';
      op.message = 'Inspect retained tab; preparation has not been confirmed. Do not upload again automatically';
      await save(file, op);
      if (!state.blocked) throw new TimeoutError('Video preparation', args.timeout ?? 180, op.message);
      return result(op);
    }
    if (!op) throw new ArgumentError('Prepare an operation before submitting');
    if (op.submitted || op.status === 'published') return result({ ...op, message: 'Submission already attempted; reconcile status, never click publish again' });
    if (op.status !== 'prepared') throw new CommandExecutionError('Operation is not prepared; inspect its retained tab');
    if (!op.target || typeof page.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
    page.setActivePage(op.target);
    const state = await inspect(page, 'submit', op);
    if (state.operation_id !== op.operation_id || state.description !== op.description || !state.ready || !state.ai_selected
      || op.source_draft_id && state.draft_id !== op.source_draft_id) {
      throw new CommandExecutionError('Prepared page changed or was reloaded; refusing submission');
    }
    if (state.blocked || !state.selector) throw new CommandExecutionError('Publish requires user action or an unambiguous enabled button');
    // Persist before the irreversible click. Crashes and ambiguous receipts cannot trigger a retry.
    op.status = 'submit_unknown'; op.submitted = true;
    op.submitted_at = new Date().toISOString();
    op.message = 'Submission may have happened; reconcile before any further action';
    await save(file, op);
    await page.click(state.selector);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const after = await inspect(page, 'status', op);
        if (after.blocked || after.success) {
          op.status = after.blocked ? 'requires_user_action' : 'submitted';
          op.message = after.blocked ? 'Complete verification/terms manually; do not repeat submission' : 'UI confirms submission; publication and objectId still need reconciliation';
          await save(file, op); return result(op);
        }
      } catch { break; } // Navigation may remove the editor; keep durable unknown state.
      await page.wait(0.5);
    }
    return result(op);
  });
}

export async function videoStatus(page, args) {
  if (!args.operation || typeof args.operation !== 'string') throw new ArgumentError('--operation is required');
  if (args.id !== undefined && (typeof args.id !== 'string' || !/^\d+$/.test(args.id))) throw new ArgumentError('--id must be a complete objectId string');
  const managementId = args['management-id'];
  if (managementId !== undefined && (typeof managementId !== 'string' || managementId.length > 512 || !/^export\/[A-Za-z0-9_-]+$/.test(managementId))) throw new ArgumentError('--management-id must be an exact export/... ID from the management list');
  if ([!!args.id, !!managementId, !!args['inspect-editor']].filter(Boolean).length > 1) throw new ArgumentError('--inspect-editor, --id and --management-id cannot be combined');
  if (managementId && ['days', 'start-date', 'end-date'].some(key => args[key] !== undefined)) throw new ArgumentError('Management metrics are cumulative; date-window arguments are not supported');
  const range = resolveDateRange(args, new Date(), 30);
  const file = resolve(args.operation);
  return locked(file, async () => {
    const op = await readOperation(file);
    if (!op) throw new ArgumentError('Operation journal not found');
    if (args['inspect-editor']) {
      if (!op.target || typeof page?.setActivePage !== 'function') throw new CommandExecutionError('Retained page identity unavailable');
      page.setActivePage(op.target);
      const editor = await page.evaluate(publishScript('status', op.operation_id, op.ai_generated));
      return result(op, editor);
    }
    const id = args.id;
    if (!id && !managementId) return result({ ...op, message: 'Local status only. Supply --id or --management-id for remote reconciliation; no submission is retried' });
    if (!op.submitted) throw new CommandExecutionError('Cannot bind a published work to an operation that was never submitted');
    const currentUrl = await page.getCurrentUrl?.();
    if (currentUrl && new URL(currentUrl).pathname === '/platform/post/create') {
      throw new CommandExecutionError('Retained editor is still open; preserve it and use posts/post-detail separately instead of navigating away for reconciliation');
    }
    if (managementId) {
      const raw = await fetchManagementPost(page, managementId);
      const metrics = normalizePost(raw);
      // Publishing a saved draft creates a different management object ID.
      // Keep source_draft_id separately and verify the new work's time/content.
      if (raw.status !== 1 || metrics.title !== op.description || Date.parse(metrics.published_at) < Date.parse(op.submitted_at || op.created_at) - 60_000) {
        throw new CommandExecutionError('Management work does not match the submitted description, time or published status');
      }
      op.status = 'published'; op.management_id = managementId;
      op.metrics = metrics; op.metrics_source = 'management_cumulative'; op.analytics = null;
      op.message = 'Matched current account management record and cumulative metrics; numeric statistics ID and daily analytics are separate';
      await save(file, op); return result(op);
    }
    // Reuse the existing list, single-post client and mapping; no parallel analytics implementation.
    const posts = await fetchPosts(page, range, args.limit ?? 100);
    const raw = posts.find(item => item.objectId === id);
    if (!raw) throw new EmptyResultError('weixin-channels video-status', 'objectId not found in the selected publication window; today is excluded');
    const metrics = normalizePost(raw);
    if (metrics.title !== op.description || Date.parse(metrics.published_at) < Date.parse(op.created_at) - 60_000) {
      throw new CommandExecutionError('Published work does not match the prepared description and submission time');
    }
    const detail = await fetchPostDetail(page, id, range);
    op.status = 'published'; op.id = id; op.metrics = metrics;
    op.metrics_source = 'statistics';
    op.analytics = normalizeDetail(detail.data, detail.retention, id, range);
    op.message = 'Matched current account work and collected existing post-detail analytics';
    await save(file, op); return result(op);
  });
}
