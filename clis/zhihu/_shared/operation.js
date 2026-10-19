import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
export async function readOperation(file) {
    let op;
    try { op = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new ArgumentError('Cannot read the operation journal'); }
    if (op.version !== 1 || op.site !== 'zhihu' || !['article', 'video', 'answer'].includes(op.kind)
        || !/^[a-f0-9-]{36}$/.test(op.operation_id || '') || typeof op.submitted !== 'boolean'
        || typeof op.body !== 'string' || typeof op.title !== 'string' || !['yes', 'no'].includes(op.ai_generated)
        || !Number.isFinite(Date.parse(op.created_at)) || typeof op.status !== 'string'
        || !Number.isInteger(op.image_count) || op.image_count < 0 || !Array.isArray(op.images)
        || op.draft_id != null && (typeof op.draft_id !== 'string' || !/^\d+$/.test(op.draft_id))
        || op.kind === 'answer' && !/^\d+$/.test(op.question_id || '')
        || op.kind === 'video' && (!['yes', 'no'].includes(op.original) || typeof op.category !== 'string')
        || op.image_keys != null && (!Array.isArray(op.image_keys) || op.image_keys.some(x => typeof x !== 'string'))
        || op.author_identity != null && !/^[\w-]+$/.test(op.author_identity)) throw new ArgumentError('Invalid Zhihu operation journal');
    return op;
}
export async function saveOperation(file, op) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(tmp, JSON.stringify(op, null, 2), { mode: 0o600 }); await rename(tmp, file); }
    finally { await unlink(tmp).catch(() => {}); }
}
export async function withOperation(path, fn) {
    if (typeof path !== 'string' || !path) throw new ArgumentError('--operation must name a local journal path');
    const file = resolve(path); let lock;
    try { lock = await open(`${file}.lock`, 'wx', 0o600); }
    catch { throw new CommandExecutionError('Operation is locked or its parent directory is unavailable; do not repeat submission'); }
    try { return await fn(file, await readOperation(file)); }
    finally { await lock.close(); await unlink(`${file}.lock`); }
}
export async function localFile(path, image = false) {
    if (typeof path !== 'string' || !path) throw new ArgumentError('A local media path is required');
    const file = resolve(path); let info;
    try { info = await stat(file); } catch { throw new ArgumentError('Local media file not found'); }
    if (!info.isFile() || !info.size) throw new ArgumentError('Local media file must be nonempty');
    if (image && !/\.(png|jpe?g|webp|gif)$/i.test(file)) throw new ArgumentError('Images must be PNG, JPEG, WEBP or GIF');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { path: file, sha256: hash.digest('hex'), bytes: info.size };
}
export async function plainBody(args) {
    if (args.text !== undefined && args.file !== undefined) throw new ArgumentError('Use --text or --file, not both');
    let text = args.text;
    if (args.file) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(args.file)); }
        catch { throw new ArgumentError('--file must be a readable UTF-8 body file'); }
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new ArgumentError('Body must contain 1–50000 characters');
    return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
}
