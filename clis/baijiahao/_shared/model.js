import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';

export function exactId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,24}$/.test(value)) throw new ArgumentError(`${label} must be an exact decimal string`);
  return value;
}
export function backendId(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value)) return value;
  throw new CommandExecutionError(`Baijiahao returned an invalid or imprecise ${label}`);
}
export function count(value, label) {
  if (value === undefined || value === null || value === '--') return null;
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new CommandExecutionError(`Invalid Baijiahao counter: ${label}`);
  return Number(value);
}
export function day(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ArgumentError(`${label} must be YYYY-MM-DD`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new ArgumentError(`${label} is not a calendar date`);
  return value;
}
export function statisticsRange(args = {}, publicationDay, now = new Date()) {
  const explicit = args['start-date'] !== undefined || args['end-date'] !== undefined;
  if (explicit && (args['start-date'] === undefined || args['end-date'] === undefined)) throw new ArgumentError('Supply both --start-date and --end-date');
  const start = day(explicit ? args['start-date'] : publicationDay, 'start-date');
  const end = day(explicit ? args['end-date'] : publicationDay, 'end-date');
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  if (start > end || end > today) throw new ArgumentError('Date range must be ordered and no later than Shanghai today');
  return { start, end };
}
export const platformType = kind => kind === 'video' ? 'video' : 'news';
export function publicUrl(raw, kind) {
  const candidates = kind === 'video' ? [raw.share_url] : [raw.url, raw.share_url];
  for (const value of candidates) {
    if (!value) continue;
    try {
      const target = publicTarget(value);
      if (kind === 'video' && target.source === 'baijiahao-video' && target.id === String(raw.nid)
        || kind !== 'video' && target.source === 'baijiahao-content' && target.id === String(raw.article_id)) return target.url;
    } catch { /* Preview/internal URLs are not public publication evidence. */ }
  }
  return null;
}
export function publicTarget(value) {
  let u;
  try { u = new URL(value); } catch { throw new ArgumentError('Supply an exact public Baijiahao or Haokan video URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) throw new ArgumentError('Unsupported public URL');
  let id, source, url;
  if (u.hostname === 'mbd.baidu.com' && u.pathname === '/newspage/data/videolanding' && /^sv_[1-9]\d{0,24}$/.test(u.searchParams.get('nid') || '')) {
    id = u.searchParams.get('nid').slice(3); source = 'baijiahao-video';
    url = `https://mbd.baidu.com/newspage/data/videolanding?nid=sv_${id}`;
  } else if (u.hostname === 'baijiahao.baidu.com' && u.pathname === '/s' && /^[1-9]\d{0,24}$/.test(u.searchParams.get('id') || '')) {
    id = u.searchParams.get('id'); source = 'baijiahao-content'; url = `https://baijiahao.baidu.com/s?id=${id}`;
  } else if (u.hostname === 'haokan.baidu.com' && u.pathname === '/v' && /^[1-9]\d{0,24}$/.test(u.searchParams.get('vid') || '')) {
    id = u.searchParams.get('vid'); source = 'haokan-video'; url = `https://haokan.baidu.com/v?vid=${id}`;
  } else throw new ArgumentError('Use a public /s, videolanding or Haokan /v URL; draft previews and internal URLs are not supported');
  return { id, source, url };
}
export function normalizeManagement(raw, expectedId, kind) {
  if (!raw || backendId(raw.article_id, 'management id') !== expectedId || raw.type !== platformType(kind)) throw new CommandExecutionError('Baijiahao work identity or content type does not match');
  const nid = backendId(raw.nid, 'nid');
  if (typeof raw.title !== 'string' || typeof raw.status !== 'string') throw new CommandExecutionError('Baijiahao work title/status is unavailable');
  return { id: expectedId, nid, title: raw.title, status: raw.status, publishedAt: raw.publish_at || null, publicUrl: publicUrl(raw, kind) };
}
export const statsColumns = kind => ['id', 'nid', 'contentKind', 'title', 'status', kind === 'video' ? 'plays' : 'reads', 'likes', 'comments', 'collections', 'shares', 'observation', 'unavailableMetrics'];
export function normalizeStatistics(raw, work, kind, range, sampledAt = new Date().toISOString()) {
  if (!raw || backendId(raw.id, 'statistics management id') !== work.id || backendId(raw.nid, 'statistics nid') !== work.nid
      || backendId(raw.article_id, 'internal article id') !== work.nid || raw.type !== platformType(kind)
      || raw.status !== 'publish' || raw.title !== work.title) throw new CommandExecutionError('Statistics do not match the exact published work');
  const metrics = { [kind === 'video' ? 'plays' : 'reads']: count(raw.view_count, 'view_count'), likes: count(raw.likes_count, 'likes_count'), comments: count(raw.comment_count, 'comment_count'), collections: count(raw.collect_count, 'collect_count'), shares: count(raw.share_count, 'share_count') };
  if (Object.values(metrics).every(v => v === null)) throw new CommandExecutionError('No statistics counters were returned for this work');
  return { id: work.id, nid: work.nid, contentKind: kind, title: work.title, status: work.status,
    ...metrics, observation: { startDate: range.start, endDate: range.end, counterScope: 'as_returned', publishedAt: work.publishedAt, sampledAt },
    unavailableMetrics: Object.fromEntries(Object.entries(metrics).filter(([, v]) => v === null).map(([key]) => [key, 'not_returned'])) };
}
