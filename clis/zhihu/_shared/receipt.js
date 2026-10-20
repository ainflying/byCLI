import { CommandExecutionError } from '@sovovs/bycli/errors';

// Read the top-level JSON id token before Number conversion. Modern Zhihu IDs
// exceed MAX_SAFE_INTEGER; nested video/author ids must not be mistaken for it.
export function exactResultId(serialized) {
    const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof serialized !== 'string') {
        if (typeof value.id === 'string' && /^\d+$/.test(value.id)) return value.id;
        if (typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0) return String(value.id);
        return null;
    }
    let depth = 0, idKeys = 0; const ids = [];
    for (let i = 0; i < serialized.length; i++) {
        const c = serialized[i];
        if (c === '"') {
            let end = i + 1;
            while (end < serialized.length) { if (serialized[end] === '\\') { end += 2; continue; } if (serialized[end] === '"') break; end++; }
            const key = JSON.parse(serialized.slice(i, end + 1));
            let j = end + 1; while (/\s/.test(serialized[j] || '') && j < serialized.length) j++;
            if (depth === 1 && key === 'id' && serialized[j] === ':') {
                idKeys++; j++; while (/\s/.test(serialized[j] || '') && j < serialized.length) j++;
                const match = serialized.slice(j).match(/^(?:"(\d+)"|(\d+))\s*(?=[,}])/);
                if (match) ids.push(match[1] || match[2]);
            }
            i = end;
        } else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
    }
    return ids.length === 1 && idKeys === 1 ? ids[0] : null;
}
export function publishReceipt(entry, op, startedAt) {
    let url;
    try { url = new URL(entry.url); } catch { return null; }
    if (url.origin !== 'https://www.zhihu.com' || url.pathname !== '/api/v4/content/publish' || entry.method !== 'POST'
        || !Number.isFinite(Number(entry.timestamp)) || Number(entry.timestamp) < startedAt || entry.responseBodyTruncated) return null;
    let body; try { body = JSON.parse(entry.responsePreview); } catch { return null; }
    if (entry.responseStatus !== 200 || body.code !== 0) return { status: 'submission_rejected', type: null, id: null };
    const type = body.data?.publish_type;
    if (op.kind === 'article' ? type !== 'article' : op.kind === 'answer' ? type !== 'answer' : !['pin', 'zvideo'].includes(type)) throw new CommandExecutionError('Publish receipt content type does not match this operation');
    let id;
    try { id = exactResultId(body.data.result); } catch { return { status: 'submitted', type, id: null }; }
    if (op.kind === 'article') {
        if (id && id !== op.draft_id) throw new CommandExecutionError('Article receipt identity does not match its draft');
        id = op.draft_id;
    }
    if (op.kind === 'video' && id && id !== op.draft_id) throw new CommandExecutionError('Video receipt identity does not match its draft');
    return { status: 'submitted', type, id };
}
