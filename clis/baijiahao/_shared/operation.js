import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export async function localFile(value, image = false) {
  if (typeof value !== 'string' || !value) throw new ArgumentError('A local media path is required');
  const path = resolve(value); let info;
  try { info = await stat(path); } catch { throw new ArgumentError('Local media file not found'); }
  if (!info.isFile() || !info.size || image && !/\.(png|jpe?g|webp|gif)$/i.test(path)) throw new ArgumentError('Media must be a nonempty file; images must be PNG, JPEG, WEBP or GIF');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, bytes: info.size, sha256: hash.digest('hex') };
}
export async function bodyText(args) {
  if (args.text !== undefined && args.file !== undefined) throw new ArgumentError('Use --text or --file for the article body, not both');
  let text = args.text;
  if (args.file) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(args.file)); }
    catch { throw new ArgumentError('--file must contain readable UTF-8 plain text'); }
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new ArgumentError('Article body must contain 1–50000 characters');
  return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
}
export async function readOperation(file) {
  let op;
  try { op = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new ArgumentError('Cannot read the operation journal'); }
  if (op?.version !== 1 || op.site !== 'baijiahao' || !['video', 'article', 'image-text'].includes(op.kind)
    || !/^[a-f0-9-]{36}$/.test(op.operationId || '') || typeof op.submitted !== 'boolean' || typeof op.title !== 'string'
    || typeof op.body !== 'string' || typeof op.phase !== 'string' || typeof op.status !== 'string' || !['yes', 'no'].includes(op.aiGenerated)
    || typeof op.accountId !== 'string' || !/^[1-9]\d{0,24}$/.test(op.accountId) || op.editorSession !== `baijiahao-publish-${op.operationId}`
    || !Array.isArray(op.images) || op.id != null && (typeof op.id !== 'string' || !/^[1-9]\d{0,24}$/.test(op.id))
    || op.nid != null && (typeof op.nid !== 'string' || !/^[1-9]\d{0,24}$/.test(op.nid))
    || !Number.isFinite(Date.parse(op.createdAt))) throw new ArgumentError('Invalid Baijiahao operation journal');
  return op;
}
export async function saveOperation(file, op) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(op, null, 2), { mode: 0o600 }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}
export async function withOperation(value, fn) {
  if (typeof value !== 'string' || !value) throw new ArgumentError('--operation must name a local journal path');
  const path = resolve(value); let lock;
  try { lock = await open(`${path}.lock`, 'wx', 0o600); }
  catch { throw new CommandExecutionError('Operation is locked or its parent directory is unavailable; do not repeat submission'); }
  try { return await fn(path, await readOperation(path)); }
  finally { await lock.close(); await unlink(`${path}.lock`); }
}
