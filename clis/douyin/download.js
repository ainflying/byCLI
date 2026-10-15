import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { downloadMedia } from '@sovovs/bycli/download/media-download';
import { sanitizeFilename } from '@sovovs/bycli/download';
import { getDouyinWork, listDouyinUserWorks } from './_shared/public-content.js';

function validateTarget(value, user = false) {
    const target = String(value ?? '').trim();
    if (/^\d+$/.test(target) || (user && /^[A-Za-z0-9_-]+$/.test(target))) return target;
    const candidate = target.match(/https?:\/\/[^\s<>"']+/i)?.[0];
    try {
        const url = new URL(candidate || target);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) throw new Error();
        return target;
    } catch {
        throw new ArgumentError('Expected a Douyin work ID, Douyin URL/share text, or a creator ID with --user');
    }
}

function safeMetadata(work) {
    // Explicit fields keep raw API state, request headers and browser secrets out of files.
    const author = work.author || {};
    const statistics = Object.fromEntries(Object.entries(work.statistics || {})
        .filter(([key, value]) => /^(digg|comment|collect|share|play|download)_count$/.test(key)
            && (value === null || typeof value === 'number')));
    const url = /^\d+$/.test(String(work.aweme_id)) ? `https://www.douyin.com/${work.media_type === 'image' ? 'note' : 'video'}/${work.aweme_id}` : undefined;
    return {
        aweme_id: String(work.aweme_id), url, title: work.title ?? '', media_type: work.media_type,
        author: { uid: author.uid, sec_uid: author.sec_uid, nickname: author.nickname },
        create_time: work.create_time ?? null, duration: work.duration ?? null, statistics,
        image_count: Array.isArray(work.images) ? work.images.length : 0,
    };
}

function failedRow(awemeId, type, message) {
    return { aweme_id: String(awemeId || ''), type, status: 'failed', size: message };
}

function matchImageExtension(filePath) {
    const header = Buffer.alloc(32);
    const descriptor = fs.openSync(filePath, 'r');
    let bytesRead;
    try { bytesRead = fs.readSync(descriptor, header, 0, header.length, 0); }
    finally { fs.closeSync(descriptor); }
    const starts = hex => bytesRead >= hex.length / 2 && header.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
    if (starts('ffd8ff')) return '.jpg';
    if (starts('89504e470d0a1a0a')) return '.png';
    if (bytesRead >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    if (bytesRead >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) return '.gif';
    if (starts('424d')) return '.bmp';
    if (starts('49492a00') || starts('4d4d002a')) return '.tiff';
    if (starts('00000100')) return '.ico';
    if (bytesRead >= 12 && header.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.toString('ascii', 8, 12))) return '.avif';
    return '.bin';
}

async function saveWork(work, output, options) {
    const id = String(work.aweme_id ?? '');
    const stem = sanitizeFilename(id) || 'unknown';
    const images = Array.isArray(work.images) ? work.images : [];
    const media = work.media_type === 'image' || (images.length && !work.play_url)
        ? images.map((image, index) => ({ type: 'image', url: typeof image === 'string' ? image : image.url || image.urls?.[0], filename: `${stem}_${index + 1}.jpg` }))
        : [{ type: 'video', url: work.play_url || work.play_urls?.[0], filename: `${stem}.mp4` }];
    const rows = [];
    const artifacts = [...media.map(item => ({ ...item, artifactType: item.type }))];
    if (options.cover) artifacts.push({ type: 'image', artifactType: 'cover', url: work.cover_url, filename: `${stem}_cover.jpg` });
    if (!media.length) rows.push(failedRow(id, 'image', 'No media found'));
    for (const artifact of artifacts) {
        if (!artifact.url) {
            rows.push(failedRow(id, artifact.artifactType, 'No downloadable URL available'));
            continue;
        }
        const [result] = await downloadMedia([artifact], {
            output, headers: { Referer: 'https://www.douyin.com/' }, validateMedia: true, verbose: false,
        });
        if (artifact.type === 'image' && result.status === 'success' && result.path) {
            try {
                const extension = matchImageExtension(result.path);
                const destination = path.join(path.dirname(result.path), `${path.basename(result.path, path.extname(result.path))}${extension}`);
                if (destination !== result.path) fs.renameSync(result.path, destination);
                result.path = destination;
            } catch {
                rows.push(failedRow(id, artifact.artifactType, 'Could not name the downloaded image by its format'));
                continue;
            }
        }
        rows.push({ ...result, aweme_id: id, type: artifact.artifactType });
    }
    if (options.metadata) {
        const destination = path.join(output, `${stem}.json`);
        try {
            const content = JSON.stringify(safeMetadata(work), null, 2);
            fs.mkdirSync(output, { recursive: true });
            fs.writeFileSync(destination, content, 'utf8');
            rows.push({ aweme_id: id, type: 'metadata', status: 'success', path: destination, bytes: Buffer.byteLength(content), size: `${Buffer.byteLength(content)} B` });
        } catch {
            rows.push(failedRow(id, 'metadata', 'Failed to save metadata'));
        }
    }
    return rows;
}

export const command = cli({
    site: 'douyin', name: 'download', access: 'read',
    description: '下载抖音视频或图集，支持批量文件和创作者作品样本',
    domain: 'www.douyin.com', strategy: Strategy.COOKIE, navigateBefore: false,
    args: [
        { name: 'target', positional: true, type: 'string', help: '作品 ID、链接、分享文本；--user 模式下为用户 ID 或主页链接' },
        { name: 'output', default: './douyin-downloads', help: '输出目录' },
        { name: 'cover', type: 'bool', default: false, help: '同时下载封面' },
        { name: 'metadata', type: 'bool', default: false, help: '保存作品元数据 JSON' },
        { name: 'batch', type: 'string', help: '每行一个作品目标的文本文件（支持 # 注释）' },
        { name: 'user', type: 'bool', default: false, help: '下载创作者的有限作品样本' },
        { name: 'limit', type: 'int', default: 20, help: '创作者样本数量（最大 100）' },
        { name: 'cursor', type: 'string', help: '创作者作品分页游标' },
    ],
    columns: ['index', 'aweme_id', 'type', 'status', 'path', 'bytes', 'size', 'has_more', 'cursor', 'next_cursor', 'truncated', 'sample_limit'],
    func: async (page, kwargs) => {
        if (kwargs.batch && (kwargs.target || kwargs.user)) throw new ArgumentError('--batch cannot be combined with a target or --user');
        const output = path.resolve(String(kwargs.output || './douyin-downloads'));
        let targets;
        if (kwargs.batch) {
            let text;
            try { text = fs.readFileSync(String(kwargs.batch), 'utf8'); }
            catch { throw new ArgumentError('Could not read the batch file'); }
            targets = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')))];
            if (!targets.length) throw new ArgumentError('The batch file contains no targets');
            targets.forEach(target => validateTarget(target));
        } else {
            targets = [validateTarget(kwargs.target, kwargs.user === true)];
        }
        const rows = [];
        let pagination = {};
        if (kwargs.user) {
            const numericLimit = Number(kwargs.limit ?? 20);
            const limit = Number.isFinite(numericLimit) ? Math.max(1, Math.min(100, Math.round(numericLimit))) : 20;
            const listed = await listDouyinUserWorks(page, targets[0], { limit, cursor: kwargs.cursor });
            pagination = { has_more: listed.has_more ?? null, cursor: listed.cursor ?? listed.next_cursor ?? null, next_cursor: listed.cursor ?? listed.next_cursor ?? null, truncated: listed.truncated ?? null, sample_limit: limit };
            for (const work of listed.items.slice(0, limit)) rows.push(...await saveWork(work, output, kwargs));
        } else {
            for (const target of targets) {
                try { rows.push(...await saveWork(await getDouyinWork(page, target), output, kwargs)); }
                catch (error) {
                    if (!kwargs.batch) throw error;
                    rows.push(failedRow(/^\d+$/.test(target) ? target : '', 'resolution', 'Could not resolve the Douyin work'));
                }
            }
        }
        const results = rows.map((row, index) => ({ ...row, ...pagination, index: index + 1 }));
        if (!results.some(row => ['video', 'image'].includes(row.type) && row.status === 'success')) {
            const error = new CliError('DOWNLOAD_FAILED', 'No Douyin media could be downloaded', JSON.stringify({ results }));
            error.results = results;
            throw error;
        }
        return results;
    },
});
