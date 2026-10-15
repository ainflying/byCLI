import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { getDouyinWork, listDouyinComments } from './_shared/public-content.js';
import { analyzeDouyinEvidence } from './_shared/analysis.js';

const MAX_SUBTITLE_BYTES = 1024 * 1024;
function safeSubtitleUrl(value) {
    try {
        const url = new URL(value);
        const hosts = ['douyin.com', 'douyinvod.com', 'byteimg.com', 'ibytedtos.com', 'bytecdn.cn'];
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
    } catch { return null; }
}
function time(value) {
    const parts = value.replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return NaN;
    return parts.reduce((result, part) => result * 60 + part, 0);
}
function parseCues(text, format) {
    if (format === 'json') {
        const data = JSON.parse(text);
        const milliseconds = Array.isArray(data?.utterances);
        const rows = Array.isArray(data) ? data : data?.utterances ?? data?.subtitles ?? data?.body;
        if (!Array.isArray(rows)) throw new Error('invalid_format');
        return rows.map(row => ({ from: milliseconds ? Number(row.start_time) / 1000 : Number(row.from ?? row.start), to: milliseconds ? Number(row.end_time) / 1000 : Number(row.to ?? row.end), text: String(row.text ?? row.content ?? '') }));
    }
    const cues = [];
    for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
        const lines = block.split('\n');
        const at = lines.findIndex(line => line.includes('-->'));
        if (at < 0) continue;
        const match = lines[at].match(/([\d:.,]+)\s+-->\s+([\d:.,]+)/);
        if (!match) throw new Error('invalid_format');
        cues.push({ from: time(match[1]), to: time(match[2]), text: lines.slice(at + 1).join('\n') });
    }
    return cues;
}
async function subtitleEvidence(track) {
    const base = { language: typeof track.language === 'string' ? track.language : null, source: 'official_subtitle' };
    const unavailable = reason => ({ ...base, status: 'unavailable', reason, cues: [] });
    const url = safeSubtitleUrl(track.url);
    if (!url) return unavailable('unsafe_url');
    const format = String(track.format ?? new URL(url).pathname.split('.').pop() ?? '').toLowerCase();
    if (!['json', 'vtt', 'webvtt', 'srt'].includes(format)) return unavailable('unsupported_format');
    try {
        const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
        if (!response.ok) return unavailable('http_error');
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (type && !['application/json', 'text/json', 'text/plain', 'text/vtt', 'application/x-subrip', 'application/octet-stream'].includes(type)) { await response.body?.cancel(); return unavailable('unsupported_content_type'); }
        if (Number(response.headers.get('content-length')) > MAX_SUBTITLE_BYTES) { await response.body?.cancel(); return unavailable('size_limit'); }
        const chunks = []; let size = 0;
        if (!response.body) return unavailable('empty_body');
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > MAX_SUBTITLE_BYTES) throw new Error('size_limit');
            chunks.push(Buffer.from(chunk));
        }
        const cues = parseCues(Buffer.concat(chunks).toString('utf8'), format);
        if (!cues.length || cues.length > 10000 || cues.some(cue => !Number.isFinite(cue.from) || !Number.isFinite(cue.to) || cue.from < 0 || cue.to < cue.from)) return unavailable('invalid_format');
        return { ...base, format, status: 'available', cues };
    } catch (error) { return unavailable(error?.message === 'size_limit' ? 'size_limit' : 'fetch_or_parse_failed'); }
}

cli({
    site: 'douyin', name: 'read', access: 'read', domain: 'www.douyin.com', strategy: Strategy.COOKIE,
    description: '读取作品、评论与可用官方字幕的结构化证据包；不生成虚构转录',
    args: [
        { name: 'target', type: 'string', required: true, positional: true, help: '作品 ID、链接或分享文本' },
        { name: 'comments', type: 'int', default: 0, help: '评论样本数量（0 不读取，最大 200）' },
        { name: 'replies', type: 'int', default: 0, help: '每条评论的回复上限（最大 50）' },
    ],
    columns: ['work', 'comments', 'subtitles', 'analysis', 'limitations'],
    func: async (page, kwargs) => {
        const count = Number(kwargs.comments ?? 0);
        if (!Number.isFinite(count) || count < 0) throw new CommandExecutionError('Comment count must be a nonnegative number');
        const work = await getDouyinWork(page, kwargs.target);
        const comments = count > 0 ? await listDouyinComments(page, work.aweme_id, { limit: count, replies: kwargs.replies }) : null;
        const tracks = Array.isArray(work.subtitles) ? work.subtitles : [];
        const subtitles = [];
        for (const track of tracks.slice(0, 3)) subtitles.push(await subtitleEvidence(track));
        const limitations = ['No audio transcription, frame extraction or external AI analysis is performed; visual/audio content is not inferred from metadata.'];
        if (!comments) limitations.push('Comments were not requested.');
        if (!tracks.length) limitations.push('No official subtitles were exposed by the work metadata.');
        if (tracks.length > 3) limitations.push('Subtitle evidence is limited to the first three tracks (1 MiB per track).');
        if (subtitles.some(track => track.status !== 'available')) limitations.push('Some official subtitles could not be safely fetched or parsed.');
        return [{ work, comments, subtitles, analysis: analyzeDouyinEvidence({ work, comments }), limitations }];
    },
});
