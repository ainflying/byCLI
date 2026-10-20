import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@sovovs/bycli/errors';
import { downloadMedia } from '@sovovs/bycli/download/media-download';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, link, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publicTarget } from './model.js';

export function publicVideoDOM() {
  const u = new URL(location.href);
  const allowed = u.hostname === 'baijiahao.baidu.com' && u.pathname === '/s'
    || u.hostname === 'mbd.baidu.com' && u.pathname === '/newspage/data/videolanding'
    || u.hostname === 'haokan.baidu.com' && u.pathname === '/v';
  if (!allowed) return { error: 'wrong_page' };
  if (/安全验证|验证码|登录后观看|付费观看/.test(document.body.innerText || '')) return { error: 'verification_or_access_required' };
  const media = [...document.querySelectorAll('video')].map(v => ({ src: v.currentSrc || v.src, duration: Number.isFinite(v.duration) ? v.duration : null, width: v.videoWidth, height: v.videoHeight }))
    .filter(v => /^https?:\/\//.test(v.src));
  const unique = [...new Map(media.map(v => [v.src, v])).values()];
  return { url: location.href, title: document.title, media: unique };
}
export function validateDownload(args) {
  publicTarget(args.url);
  if (typeof args.output !== 'string' || !args.output) throw new ArgumentError('--output must name a local directory');
  if (!Number.isInteger(args.timeout ?? 60) || (args.timeout ?? 60) < 1 || (args.timeout ?? 60) > 600) throw new ArgumentError('--timeout must be 1–600 seconds');
}
export async function downloadVideo(page, args) {
  validateDownload(args);
  const target = publicTarget(args.url), output = resolve(args.output), filename = `baijiahao-${target.source}-${target.id}.mp4`, finalPath = join(output, filename);
  try { await stat(finalPath); throw new ArgumentError('Download already exists; choose another --output directory'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await page.goto(target.url, { stealth: false });
  const deadline = Date.now() + (args.timeout ?? 60) * 1000; let state;
  do {
    state = await page.evaluate(`(${publicVideoDOM.toString()})()`);
    if (!state || state.error) throw new CommandExecutionError(`Public video page unavailable: ${state?.error || 'invalid response'}`);
    const actual = publicTarget(state.url);
    if (actual.source !== target.source || actual.id !== target.id) throw new CommandExecutionError('Public video navigation changed the requested identity');
    if (state.media.length > 1) throw new CommandExecutionError('More than one video source found; refusing to download an unrelated video');
    if (state.media.length === 1 && state.media[0].duration > 0) break;
    if (Date.now() >= deadline) {
      if (!state.media.length) throw new EmptyResultError('baijiahao video-download', 'No public playable video source was found');
      throw new TimeoutError('Public video metadata', args.timeout ?? 60);
    }
    await page.wait(0.5);
  } while (true);
  const media = state.media[0], remote = new URL(media.src);
  if (remote.protocol !== 'https:' || !/(?:^|\.)bdstatic\.com$/.test(remote.hostname) || remote.username || remote.password || remote.port) throw new CommandExecutionError('Unrecognized public video CDN source');
  await mkdir(output, { recursive: true }); const temp = await mkdtemp(join(output, '.bycli-baijiahao-'));
  try {
    const [result] = await downloadMedia([{ type: 'video', url: media.src, filename }], { output: temp, headers: { Referer: target.url }, validateMedia: true, timeout: (args.timeout ?? 60) * 1000, verbose: false });
    if (result?.status !== 'success' || !result.path || !Number.isSafeInteger(result.bytes) || result.bytes < 12) {
      const reason = typeof result?.size === 'string' ? result.size.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180) : 'invalid download receipt';
      throw new CommandExecutionError(`Video download failed: ${reason}; verify the local network/NO_PROXY configuration and retry explicitly`);
    }
    const handle = await open(result.path, 'r'); const header = Buffer.alloc(12);
    try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
    if (header.toString('ascii', 4, 8) !== 'ftyp') throw new CommandExecutionError('Download is not an MP4 media file');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(result.path)) hash.update(chunk);
    try { await link(result.path, finalPath); } catch { throw new CommandExecutionError('Could not finalize video without overwriting an existing file'); }
    return [{ id: target.id, title: state.title, sourceUrl: target.url, path: finalPath, bytes: result.bytes, durationSeconds: media.duration, width: media.width || null, height: media.height || null, sha256: hash.digest('hex') }];
  } finally { await rm(temp, { recursive: true, force: true }); }
}
