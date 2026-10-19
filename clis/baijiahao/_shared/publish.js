import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { Page } from '@sovovs/bycli/browser/page';
import { randomUUID } from 'node:crypto';
import { account, managementPost, request } from './client.js';
import { backendId, exactId, platformType } from './model.js';
import { bodyText, localFile, saveOperation, withOperation } from './operation.js';
import { publisherScript } from './publish-dom.js';
import { imageDigests, sourceImageDigests } from './images.js';

export const PUBLISH_COLUMNS = ['operationId', 'contentKind', 'status', 'submitted', 'id', 'nid', 'accountId', 'title', 'aiGenerated', 'editor', 'publicUrl', 'message'];
const modes = ['prepare', 'resume', 'reopen', 'submit', 'status'];
const compact = value => String(value || '').replace(/\s+/g, '');
const sameImages = (a, b) => a.length === b.length && a.every((item, i) => ['method', 'width', 'height', 'hash'].every(key => item[key] === b[i][key]));
const editorUrl = op => `https://baijiahao.baidu.com/builder/rc/edit?type=${op.kind === 'video' ? 'videoV2' : 'news'}${op.id ? `&article_id=${op.id}` : ''}`;
export function validatePublish(args) {
  if (!args.operation || typeof args.operation !== 'string') throw new ArgumentError('--operation must name a local journal path');
  if (!modes.includes(args.mode ?? 'prepare')) throw new ArgumentError('Unsupported publishing mode');
  if (args.mode !== 'status' && !args.execute) throw new ArgumentError('Use --execute for preparation, editor changes or submission');
  if (!Number.isInteger(args.timeout ?? 180) || (args.timeout ?? 180) < 1 || (args.timeout ?? 180) > 1800) throw new ArgumentError('--timeout must be 1–1800 seconds');
  if ((args.mode ?? 'prepare') === 'prepare' && (typeof args.title !== 'string' || args.title.trim().length < 2 || !['yes', 'no'].includes(args['ai-generated']))) throw new ArgumentError('Preparation requires --title and explicit --ai-generated yes/no');
  if (args['draft-id'] !== undefined) { exactId(args['draft-id'], 'draft-id'); if (args.mode !== 'resume') throw new ArgumentError('--draft-id is only for recovering an unknown save receipt with resume'); }
}
function result(op) {
  return [{ operationId: op.operationId, contentKind: op.kind, status: op.status, submitted: op.submitted,
    id: op.id ?? null, nid: op.nid ?? null, accountId: op.accountId, title: op.title, aiGenerated: op.aiGenerated,
    editor: { phase: op.phase, url: editorUrl(op) }, publicUrl: op.publicUrl ?? null, message: op.message ?? '' }];
}
async function inspect(page, action, op, body) {
  const state = await page.evaluate(publisherScript(op.kind, action, op, body));
  if (!state || state.error) throw new CommandExecutionError(`Baijiahao editor unavailable: ${state?.error || 'invalid response'}`);
  return state;
}
async function waitFor(page, op, timeout, predicate, label) {
  const deadline = Date.now() + timeout * 1000;
  do {
    const state = await inspect(page, 'status', op);
    if (state.verification) throw new CommandExecutionError('Complete verification manually in the retained editor; do not repeat submission');
    if (predicate(state)) return state;
    if (Date.now() >= deadline) throw new TimeoutError(label, timeout);
    await page.wait(0.5);
  } while (true);
}
async function act(page, op, action, value) {
  await page.focusWindow();
  const state = await inspect(page, action, op);
  if (state.operationId !== op.operationId || state.verification || !state.selector) throw new CommandExecutionError(`Unique ${action} control unavailable; inspect the retained editor`);
  await page.wait(0.15);
  if (Array.isArray(value)) await page.uploadFiles(state.selector, value);
  else if (typeof value === 'string') {
    const reply = await page.fillText(state.selector, value);
    if (!reply?.verified) throw new CommandExecutionError(`${action} input was not verified`);
  } else if (typeof value === 'boolean') await page.setChecked(state.selector, value);
  else await page.click(state.selector);
  return state;
}
async function snapshot(page, op) {
  const state = await inspect(page, 'status', op);
  if (state.operationId !== op.operationId || state.verification || state.title !== op.title || !state.aiSelected || !state.mediaReady || !state.coversReady) throw new CommandExecutionError('Prepared title, declaration, video or cover changed');
  if (op.kind !== 'video' && (compact(state.body) !== compact(op.body) || !state.podcastDisabled || !state.imagesReady || state.imageKeys.length !== op.images.length)) throw new CommandExecutionError('Prepared article body, ordered images or podcast setting changed');
  if (op.kind !== 'video') {
    const expected = op.imageDigests ?? await sourceImageDigests(page, op.images);
    if (!sameImages(expected, await imageDigests(page, state.imageKeys))) throw new CommandExecutionError('Prepared article images do not match the ordered source files');
    op.imageDigests = expected;
  }
  if (op.coverKeys && JSON.stringify(op.coverKeys) !== JSON.stringify(state.coverKeys)) {
    if (!sameImages(await imageDigests(page, op.coverKeys), await imageDigests(page, state.coverKeys))) throw new CommandExecutionError('Prepared cover identities changed');
  }
  return state;
}
async function remoteDraft(page, op) {
  const data = await request(page, `/pcui/article/edit?type=${platformType(op.kind)}&article_id=${op.id}`), raw = data.article;
  if (!raw || backendId(raw.id, 'draft id') !== op.id || backendId(raw.app_id, 'draft account') !== op.accountId
    || raw.type !== platformType(op.kind) || raw.title !== op.title || raw.status !== 'draft') throw new CommandExecutionError('Exact remote draft identity, account, title or draft state did not match');
  const nid = backendId(raw.nid, 'draft nid');
  if (op.nid && op.nid !== nid) throw new CommandExecutionError('Saved draft nid changed');
  op.nid = nid;
  return raw;
}
export async function collectSavedId(page, op) {
  const state = await inspect(page, 'status', op);
  if (state.id) return backendId(state.id, 'saved draft id');
  // Bridge capture reads drain in-flight entries. Wait for this save's completed
  // ResourceTiming entry before reading, otherwise its later response is lost.
  if (typeof op.saveStartedAt !== 'number') return null;
  const complete = await page.evaluate(`performance.getEntriesByType('resource').some(entry => {
    const url = new URL(entry.name);
    return url.origin === 'https://baijiahao.baidu.com' && url.pathname === '/pcui/article/save'
      && entry.startTime >= ${JSON.stringify(op.saveStartedAt)} && entry.responseEnd > 0;
  })`);
  if (!complete) return null;
  await page.wait(0.5);
  for (const item of await page.readNetworkCapture()) {
    if (item.method !== 'POST' || !/^https:\/\/baijiahao\.baidu\.com\/pcui\/article\/save(?:\?|$)/.test(item.url || '') || item.responseStatus !== 200 || item.responseBodyTruncated) continue;
    let body;
    try { body = JSON.parse(String(item.responsePreview || '').replace(/^bjhdraft\(/, '').replace(/\);?$/, '')); } catch { continue; }
    if (body.errno === 0 && body.ret?.id && body.ret.title === op.title) return backendId(body.ret.id, 'saved draft id');
  }
  return null;
}
async function prepareEditor(page, file, op, timeout, readPage) {
  const persist = async phase => { op.phase = phase; await saveOperation(file, op); };
  if (op.phase === 'created') {
    await page.goto(editorUrl(op), { stealth: false }); await page.focusWindow();
    const deadline = Date.now() + timeout * 1000;
    let state;
    do {
      state = await page.evaluate(publisherScript(op.kind, 'bind', op));
      if (!state?.error) break;
      if (state.error !== 'editor_loading' || Date.now() >= deadline) throw new CommandExecutionError('Baijiahao editor did not load');
      await page.wait(0.5);
    } while (true);
    await page.startNetworkCapture('/pcui/article/save');
    if (op.kind === 'video') {
      await persist('video_upload_started');
      await act(page, op, 'video', [op.video.path]);
    } else await persist('content');
  }
  if (op.phase === 'video_upload_started') {
    await waitFor(page, op, timeout, s => s.mediaReady && s.title !== null, 'Video upload and processing');
    await persist('content');
  }
  if (op.phase === 'content') {
    await waitFor(page, op, timeout, s => s.title !== null && (op.kind === 'video' || s.body !== null), 'Content editor');
    await act(page, op, 'title', op.title);
    if (op.kind !== 'video') {
      await page.focusWindow();
      const written = await page.evaluate(publisherScript(op.kind, 'body', op, op.body));
      if (!written?.bodyWritten) throw new CommandExecutionError('Article body input was not verified');
    }
    await persist('images');
  }
  if (op.phase === 'images') {
    if (op.images.length) {
      const before = await inspect(page, 'status', op);
      if (before.imageKeys.length) throw new CommandExecutionError('Unexpected existing images; refusing duplicate upload');
      await act(page, op, 'image-dialog');
      await waitFor(page, op, timeout, s => s.dialogText.includes('本地图片'), 'Article image dialog');
      await persist('image_upload_started');
      await act(page, op, 'images', op.images.map(n => n.path));
      await page.wait(1);
    } else await persist('cover');
  }
  if (op.phase === 'image_upload_started') {
    await act(page, op, 'confirm');
    const state = await waitFor(page, op, timeout, s => s.imagesReady && s.imageKeys.length === op.images.length, 'Article images');
    op.imageKeys = state.imageKeys; await persist('cover');
  }
  for (const phase of ['cover', 'vertical-cover']) {
    if (op.phase === phase) {
      if (op.kind === 'video') await act(page, op, phase, [phase === 'cover' ? op.cover.path : op.verticalCover.path]);
      else {
        if (!(await inspect(page, 'status', op)).dialogText.includes('正文/本地上传')) await act(page, op, 'cover');
        await waitFor(page, op, timeout, s => s.dialogText.includes('正文/本地上传'), 'Article cover dialog');
        await act(page, op, 'cover-file', [op.cover.path]);
      }
      await persist(`${phase}_uploaded`); await page.wait(1);
    }
    if (op.phase === `${phase}_uploaded`) {
      await act(page, op, 'confirm'); await page.wait(0.5);
      await persist(phase === 'cover' && op.kind === 'video' ? 'vertical-cover' : 'declaration');
    }
  }
  if (op.phase === 'declaration') {
    if (op.kind !== 'video') { await act(page, op, 'podcast', false); await act(page, op, 'ai', op.aiGenerated === 'yes'); }
    else for (let n = 0; n < 4; n++) {
      if ((await inspect(page, 'status', op)).aiSelected) break;
      await act(page, op, 'ai'); await page.wait(0.25);
    }
    await waitFor(page, op, timeout, s => s.aiSelected && s.coversReady, 'Cover and declaration');
    const state = await snapshot(page, op); op.imageKeys = state.imageKeys; op.coverKeys = state.coverKeys;
    await persist('save');
  }
  if (op.phase === 'save') {
    await snapshot(page, op);
    if (!await page.startNetworkCapture('/pcui/article/save')) throw new CommandExecutionError('Native save response capture is required');
    op.saveStartedAt = await page.evaluate('performance.now()');
    await persist('saving'); await act(page, op, 'save');
  }
  if (op.phase === 'saving') {
    const deadline = Date.now() + timeout * 1000;
    while (!op.id) {
      op.id = await collectSavedId(page, op);
      if (op.id) { await saveOperation(file, op); break; }
      if (Date.now() >= deadline) throw new TimeoutError('Draft save receipt', timeout, 'No save retry was made; inspect the retained editor');
      await page.wait(0.5);
    }
    await remoteDraft(readPage, op);
    await persist('reopen');
  }
  if (op.phase === 'reopen') {
    await page.goto(editorUrl(op), { stealth: false }); await page.wait(1); await page.focusWindow();
    await inspect(page, 'bind', op);
    await waitFor(page, op, timeout, s => s.title === op.title && s.mediaReady && s.coversReady
      && (op.kind === 'video' || s.body !== null && s.imagesReady && s.imageKeys.length === op.images.length), 'Reopened draft');
    // Native checkbox/select state can be omitted from the saved draft. Restore only the recorded choice.
    if (op.kind !== 'video') { await act(page, op, 'podcast', false); await act(page, op, 'ai', op.aiGenerated === 'yes'); }
    else for (let n = 0; n < 4 && !(await inspect(page, 'status', op)).aiSelected; n++) { await act(page, op, 'ai'); await page.wait(0.25); }
    await snapshot(page, op); await remoteDraft(readPage, op);
    op.status = 'prepared'; op.message = 'Exact platform draft saved and reopened; not submitted'; await persist('prepared');
  }
  return result(op);
}

export async function publish(page, args, kind, createEditor = (session, profile) => new Page(session, 3600, profile, 'foreground', 'browser')) {
  validatePublish(args); const mode = args.mode ?? 'prepare';
  return withOperation(args.operation, async (file, existing) => {
    let op = existing;
    if (op && platformType(op.kind) !== platformType(kind)) throw new ArgumentError('Operation content type does not match this command');
    if (mode === 'prepare') {
      if (op) return result({ ...op, message: 'Existing operation retained; use resume/status instead of uploading or submitting again' });
      const title = args.title.trim();
      if (title.length > (kind === 'video' ? 50 : 64)) throw new ArgumentError('Title exceeds the platform limit');
      if (kind === 'video' && args.text !== undefined || kind !== 'video' && args['vertical-cover'] !== undefined) throw new ArgumentError('Video text and article vertical-cover options are not supported');
      let imagePaths = [];
      if (args.images !== undefined) { try { imagePaths = JSON.parse(args.images); } catch { throw new ArgumentError('--images must be a JSON array of local image paths'); } }
      if (!Array.isArray(imagePaths) || imagePaths.length > 20 || imagePaths.some(n => typeof n !== 'string') || kind === 'video' && imagePaths.length) throw new ArgumentError('Invalid images list; video uses covers only');
      const body = kind === 'video' ? '' : await bodyText(args);
      const images = []; for (const path of imagePaths) images.push(await localFile(path, true));
      if (kind === 'image-text' && !images.length) throw new ArgumentError('image-text requires at least one image');
      const cover = await localFile(args.cover, true), video = kind === 'video' ? await localFile(args.file) : null;
      const verticalCover = kind === 'video' ? await localFile(args['vertical-cover'], true) : null;
      const operationId = randomUUID(), accountId = await account(page);
      op = { version: 1, site: 'baijiahao', kind, operationId, editorSession: `baijiahao-publish-${operationId}`, accountId,
        createdAt: new Date().toISOString(), title, body, images, cover, verticalCover, video, aiGenerated: args['ai-generated'],
        status: 'preparing', phase: 'created', submitted: false };
      await saveOperation(file, op);
    }
    if (!op) throw new ArgumentError('Prepare an operation before resuming, submitting or reading status');
    await account(page, op.accountId);
    if (mode === 'status') {
      if (!op.id) return result({ ...op, message: 'Draft save has not been confirmed; original editor retained' });
      const work = await managementPost(page, op.id, kind);
      if (work.title !== op.title || op.nid && op.nid !== work.nid) throw new CommandExecutionError('Remote work identity changed');
      if (work.status === 'publish' && !op.submitted) throw new CommandExecutionError('Remote work was published outside this operation; refusing to claim command publication');
      op.nid = work.nid; op.publicUrl = work.publicUrl;
      op.status = work.status === 'publish' ? 'published' : op.submitted ? work.status === 'draft' ? 'submission_pending' : work.status : op.status;
      op.message = `Exact current-account work state: ${work.status}; no submission retried`;
      await saveOperation(file, op); return result(op);
    }
    if (op.submitted) return result({ ...op, message: 'Submission was already attempted; use status, never resubmit automatically' });
    if (mode !== 'submit') {
      for (const source of [op.video, op.cover, op.verticalCover, ...op.images].filter(Boolean)) {
        if ((await localFile(source.path)).sha256 !== source.sha256) throw new CommandExecutionError('A recorded source file changed; preparation was not resumed');
      }
    }
    const editor = createEditor(op.editorSession, page.contextId);
    try {
      if (args['draft-id'] !== undefined) {
        if (op.id || op.phase !== 'saving') throw new ArgumentError('Exact draft ID recovery requires an unconfirmed save receipt');
        await snapshot(editor, op);
        const pending = { ...op, id: args['draft-id'] };
        await remoteDraft(page, pending);
        op.id = pending.id; op.nid = pending.nid; op.phase = 'reopen'; await saveOperation(file, op);
      }
      if (mode === 'submit') {
        if (op.status !== 'prepared' || !op.id) throw new CommandExecutionError('Prepare and verify the remote draft before submission');
        await account(editor, op.accountId); await remoteDraft(page, op); await snapshot(editor, op);
        const state = await inspect(editor, 'submit', op);
        if (!state.selector) throw new CommandExecutionError('Publish control is unavailable');
        op.submitted = true; op.submittedAt = new Date().toISOString(); op.status = 'submission_unknown';
        op.message = 'Submission attempted once; reconcile the exact ID before further action'; await saveOperation(file, op);
        await editor.focusWindow(); await editor.wait(0.15); await editor.click(state.selector);
        for (let n = 0; n < 10; n++) {
          await editor.wait(0.5);
          const state = await editor.evaluate(publisherScript(kind, 'status', op));
          if (state?.verification) { op.status = 'verification_required'; op.message = 'Complete the current verification manually; then use status without clicking publish again'; await saveOperation(file, op); break; }
          if (state?.error === 'wrong_editor') break;
        }
        return result(op);
      }
      if (mode === 'reopen') {
        if (!op.id) throw new CommandExecutionError('A saved draft ID is required before reopening');
        await remoteDraft(page, op); op.phase = 'reopen'; op.status = 'preparing'; await saveOperation(file, op);
      }
      return await prepareEditor(editor, file, op, args.timeout ?? 180, page);
    } catch (error) {
      if (!op.submitted) op.status = 'preparation_unknown';
      op.message = 'Operation interrupted; original editor and phase retained. Inspect it and explicitly resume; do not create another operation';
      await saveOperation(file, op); throw error;
    }
  });
}
export function makeBaijiahaoPublishCommand(name, kind) {
  return cli({ site: 'baijiahao', name, access: 'write', domain: 'baijiahao.baidu.com', strategy: Strategy.UI, browser: true, navigateBefore: false,
    description: `${kind === 'video' ? '视频' : '图文/文章'}准备、上传、保存草稿、重开核对、单次提交和精确状态读取；人工完成验证码`,
    validateArgs: validatePublish,
    args: [
      { name: 'operation', required: true, help: '持久操作记录路径，父目录须已存在；不得删除后重试未知提交' },
      { name: 'mode', choices: modes, default: 'prepare', help: 'prepare 上传保存；resume 原页续办；reopen 核对已保存草稿；submit 单次公开提交；status 只读取状态' },
      { name: 'title', help: 'prepare 必填：视频 2–50 字，文章 2–64 字' },
      { name: 'file', help: 'prepare：视频文件或 UTF-8 纯文本正文；正文不包含标题' },
      { name: 'text', help: 'prepare：纯文本正文，与 file 二选一' },
      { name: 'draft-id', type: 'str', help: '仅 resume：保存回执未知时，提供已核对的精确草稿 ID；不重新保存或按标题猜测' },
      { name: 'images', help: 'prepare：有序本地图片路径 JSON 数组；追加到正文末尾' },
      { name: 'cover', help: 'prepare：横版封面文件' },
      { name: 'vertical-cover', help: 'prepare 视频必填：竖版封面文件，可用同图裁切' },
      { name: 'ai-generated', choices: ['yes', 'no'], help: 'prepare 必填：按实际内容声明' },
      { name: 'timeout', type: 'int', default: 180, help: '各阶段等待秒数 1–1800；超时保留原页和操作记录' },
      { name: 'execute', type: 'boolean', help: '执行准备、重开、恢复或提交；status 不需要' },
    ], columns: PUBLISH_COLUMNS, func: (page, args) => publish(page, args, kind) });
}
