import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const resolver = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock('./_shared/public-content.js', () => ({ getDouyinWork: resolver.get, listDouyinUserWorks: resolver.list }));
// Exercise the source implementation through the same public package boundary.
vi.mock('@sovovs/bycli/download/media-download', () => import('../../src/download/media-download.ts'));
import { command } from './download.js';
const dirs = [];
const servers = [];
let output;
let base;
let requests;
const page = { cookies: vi.fn(() => { throw new Error('Downloads must not export browser cookies'); }) };
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const webpBytes = Buffer.from('524946461000000057454250565038200400000000000000', 'hex');
const gifBytes = Buffer.from('47494638396101000100000000', 'hex');
const bmpBytes = Buffer.from('424d0e000000000000000e000000', 'hex');
const tiffBytes = Buffer.from('49492a000800000000000000', 'hex');
const icoBytes = Buffer.from('0000010001000101000000000000', 'hex');
const avifBytes = Buffer.from('0000001866747970617669660000000061766966', 'hex');
const unknownBytes = Buffer.from('unknown-image-data');
const videoBytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50]);
function work(id = '7581234567890123456', overrides = {}) {
  return { aweme_id: id, url: `https://www.douyin.com/video/${id}`, title: '../../unsafe title',
    media_type: 'video', author: { uid: '123', sec_uid: 'MS4w-test', nickname: 'creator', cookie: 'DO_NOT_PERSIST' },
    create_time: 123, duration: 2, statistics: { digg_count: null, play_count: 20 },
    play_url: `${base}/video`, play_urls: [`${base}/video`], cover_url: `${base}/cover`, images: [], subtitles: [],
    cookie: 'DO_NOT_PERSIST', localStorage: { secret: 'DO_NOT_PERSIST' }, ...overrides };
}
beforeEach(async () => {
  resolver.get.mockReset(); resolver.list.mockReset();
  output = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-download-')); dirs.push(output); requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, cookie: req.headers.cookie, referer: req.headers.referer });
    const imageResponses = { '/png-data': pngBytes, '/webp-data': webpBytes, '/gif-data': gifBytes, '/bmp-data': bmpBytes,
      '/tiff-data': tiffBytes, '/ico-data': icoBytes, '/avif-data': avifBytes, '/unknown-data': unknownBytes };
    if (imageResponses[req.url]) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(imageResponses[req.url]); return;
    }
    if (req.url === '/fail') { res.statusCode = 403; res.end(); return; }
    if (req.url === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<html>login</html>'); return; }
    if (req.url === '/empty') { res.end(); return; }
    res.setHeader('Content-Type', req.url === '/video' ? 'video/mp4' : 'image/jpeg');
    res.end(req.url === '/video' ? videoBytes : Buffer.from([255, 216, 255, 217]));
  });
  servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('douyin download', () => {
  it('saves resolved video, optional cover and secret-free metadata with exact byte counts', async () => {
    resolver.get.mockResolvedValue(work());
    const rows = await command.func(page, { target: '7581234567890123456', output, cover: true, metadata: true });
    expect(rows.map(row => row.type)).toEqual(['video', 'cover', 'metadata']);
    for (const row of rows) {
      expect(row).toMatchObject({ aweme_id: '7581234567890123456', status: 'success' });
      expect(path.isAbsolute(row.path)).toBe(true);
      expect(path.relative(output, row.path).startsWith('..')).toBe(false);
      expect(fs.statSync(row.path).size).toBe(row.bytes);
    }
    expect(fs.readFileSync(rows[0].path)).toEqual(videoBytes);
    expect(rows[1].path).toBe(path.join(output, '7581234567890123456_cover.jpg'));
    const metadata = fs.readFileSync(rows[2].path, 'utf8');
    expect(metadata).not.toContain('DO_NOT_PERSIST');
    expect(JSON.parse(metadata)).toMatchObject({ aweme_id: '7581234567890123456', statistics: { digg_count: null } });
    expect(requests.every(req => req.cookie === undefined && req.referer === 'https://www.douyin.com/')).toBe(true);
  });
  it('downloads every image in carousel order and retains failed artifacts', async () => {
    resolver.get.mockResolvedValue(work('2', { media_type: 'image', play_url: '', play_urls: [], images: [
      { url: `${base}/image-1` }, { url: `${base}/fail` }, { url: `${base}/image-3` },
    ] }));
    const rows = await command.func(page, { target: '2', output });
    expect(rows.map(row => row.status)).toEqual(['success', 'failed', 'success']);
    expect(rows.every(row => row.type === 'image')).toBe(true);
    expect(rows[1].path).toBeUndefined();
    expect(requests.map(req => req.path)).toEqual(['/image-1', '/fail', '/image-3']);
    expect(rows.filter(row => row.status === 'success').every(row => fs.statSync(row.path).size === 4)).toBe(true);
  });
  it.each([
    ['png-data', '.png', pngBytes], ['webp-data', '.webp', webpBytes], ['gif-data', '.gif', gifBytes],
    ['bmp-data', '.bmp', bmpBytes], ['tiff-data', '.tiff', tiffBytes], ['ico-data', '.ico', icoBytes],
    ['avif-data', '.avif', avifBytes], ['unknown-data', '.bin', unknownBytes],
  ])('names downloaded images and covers by their bytes for %s', async (endpoint, extension, bytes) => {
    resolver.get.mockResolvedValue(work('3', { media_type: 'image', play_url: null, play_urls: [],
      images: [{ url: `${base}/${endpoint}` }], cover_url: `${base}/${endpoint}` }));
    const rows = await command.func(page, { target: '3', output, cover: true });
    expect(rows.map(row => row.type)).toEqual(['image', 'cover']);
    expect(rows.map(row => row.path)).toEqual([path.join(output, `3_1${extension}`), path.join(output, `3_cover${extension}`)]);
    for (const row of rows) {
      expect(row.status).toBe('success'); expect(row.bytes).toBe(bytes.length);
      expect(fs.readFileSync(row.path)).toEqual(bytes);
    }
    expect(fs.existsSync(path.join(output, '3_1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(output, '3_cover.jpg'))).toBe(false);
    expect(requests.map(request => request.path)).toEqual([`/${endpoint}`, `/${endpoint}`]);
  });
  it('deduplicates batch lines and continues after one resolution failure', async () => {
    const batch = path.join(output, 'targets.txt'); fs.writeFileSync(batch, '# targets\n1\n2\n1\n');
    resolver.get.mockImplementation(async (_page, target) => { if (target === '2') throw new Error('unavailable'); return work(target); });
    const rows = await command.func(page, { batch, output });
    expect(rows.map(row => [row.aweme_id, row.status])).toEqual([['1', 'success'], ['2', 'failed']]);
    expect(fs.existsSync(rows[0].path)).toBe(true);
  });
  it('downloads a bounded creator sample and reports its pagination limitation', async () => {
    resolver.list.mockResolvedValue({ items: [work('1'), work('2')], has_more: true, cursor: '123', truncated: true });
    const rows = await command.func(page, { target: 'MS4w-test', user: true, limit: 2, cursor: '0', output });
    expect(rows.map(row => row.aweme_id)).toEqual(['1', '2']);
    expect(rows.every(row => row.has_more === true && row.next_cursor === '123' && row.cursor === '123' && row.truncated === true && row.sample_limit === 2)).toBe(true);
    expect(resolver.list).toHaveBeenCalledWith(page, 'MS4w-test', { limit: 2, cursor: '0' });
  });
  it.each(['https://evil.example/video/1', 'https://www.douyin.com.evil.example/video/1', 'file:///tmp/a'])('rejects an invalid target host: %s', async target => {
    await expect(command.func(page, { target, output })).rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(requests).toEqual([]);
    expect(resolver.get).not.toHaveBeenCalled();
  });
  it('records missing media URLs and fails even when metadata was saved', async () => {
    resolver.get.mockResolvedValue(work('1', { play_url: null, play_urls: [], cover_url: null }));
    await expect(command.func(page, { target: '1', output, cover: true, metadata: true })).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED', results: [
        { aweme_id: '1', type: 'video', status: 'failed' },
        { aweme_id: '1', type: 'cover', status: 'failed' },
        { aweme_id: '1', type: 'metadata', status: 'success' },
      ],
    });
    expect(requests).toEqual([]);
  });
  it('sanitizes unusual resolved IDs so filenames stay within output', async () => {
    resolver.get.mockResolvedValue(work('../../outside'));
    const rows = await command.func(page, { target: '1', output, metadata: true });
    expect(rows.every(row => path.relative(output, row.path).split(path.sep).length === 1)).toBe(true);
    expect(rows.every(row => fs.statSync(row.path).size === row.bytes)).toBe(true);
  });
  it.each(['/empty', '/html', '/fail'])('fails the command when all primary media fail: %s', async suffix => {
    resolver.get.mockResolvedValue(work('1', { play_url: base + suffix, play_urls: [base + suffix] }));
    let error;
    try { await command.func(page, { target: '1', output, cover: true, metadata: true }); } catch (err) { error = err; }
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(error.results.map(row => row.status)).toEqual(['failed', 'success', 'success']);
    expect(error.results[0].path).toBeUndefined();
    expect(fs.existsSync(path.join(output, '1.mp4'))).toBe(false);
  });
});
