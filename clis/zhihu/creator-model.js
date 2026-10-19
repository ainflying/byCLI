import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';

const TYPES = new Set(['article', 'answer', 'pin', 'zvideo']);
const DAY = 86400000;
function dateMs(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ArgumentError(`${label} must be YYYY-MM-DD`);
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new ArgumentError(`${label} is not a valid date`);
    return ms;
}
export function creatorDateRange(args = {}, now = new Date()) {
    const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const paired = args['start-date'] !== undefined || args['end-date'] !== undefined;
    if (paired && (args['start-date'] === undefined || args['end-date'] === undefined)) throw new ArgumentError('Supply both --start-date and --end-date');
    if (paired && args.days !== undefined) throw new ArgumentError('--days cannot be combined with explicit dates');
    let start, end;
    if (paired) { start = args['start-date']; end = args['end-date']; }
    else {
        const days = args.days ?? 7;
        if (!Number.isInteger(days) || days < 1 || days > 366) throw new ArgumentError('--days must be an integer from 1 to 366');
        end = today; start = new Date(dateMs(today, 'today') - (days - 1) * DAY).toISOString().slice(0, 10);
    }
    const first = dateMs(start, 'start-date'), last = dateMs(end, 'end-date');
    if (first > last || last > dateMs(today, 'today') || (last - first) / DAY >= 366) throw new ArgumentError('Date range must be ordered, at most 366 days and no later than Shanghai today');
    const scope = args.aggregate ?? 'cumulative';
    if (!['cumulative', 'period'].includes(scope)) throw new ArgumentError('--aggregate must be cumulative or period');
    return { start, end, scope };
}

export function creatorTarget(value, explicitType) {
    if (explicitType !== undefined && !TYPES.has(explicitType)) throw new ArgumentError('Unsupported creator content type');
    let type, id, contentUrl = null;
    const text = String(value ?? '');
    let match = text.match(/^(article|pin|zvideo):(\d+)$/);
    if (match) [, type, id] = match;
    else if ((match = text.match(/^answer:(?:(\d+):)?(\d+)$/))) {
        type = 'answer'; id = match[2];
        if (match[1]) contentUrl = `https://www.zhihu.com/question/${match[1]}/answer/${id}`;
    }
    else if (/^\d+$/.test(text) && explicitType) { type = explicitType; id = text; }
    else {
        let url;
        try { url = new URL(text); } catch { throw new ArgumentError('Use a typed content target, exact content URL or --type with an ID'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new ArgumentError('Content URL must be an ordinary HTTPS Zhihu URL');
        if (url.hostname === 'zhuanlan.zhihu.com' && (match = url.pathname.match(/^\/p\/(\d+)\/?$/))) { type = 'article'; id = match[1]; contentUrl = `${url.origin}/p/${id}`; }
        else if (url.hostname === 'www.zhihu.com' && (match = url.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)\/?$/))) { type = 'answer'; id = match[2]; contentUrl = `${url.origin}/question/${match[1]}/answer/${id}`; }
        else if (url.hostname === 'www.zhihu.com' && (match = url.pathname.match(/^\/(pin|zvideo)\/(\d+)\/?$/))) { type = match[1]; id = match[2]; contentUrl = `${url.origin}/${type}/${id}`; }
        else if (url.hostname === 'www.zhihu.com' && (match = url.pathname.match(/^\/creator\/analytics\/work\/(article|answer|pin|zvideo)\/(\d+)\/?$/))) [, type, id] = match;
        else throw new ArgumentError('Unsupported Zhihu content or creator analytics URL');
    }
    if (explicitType && explicitType !== type) throw new ArgumentError('--type conflicts with the target type; do not guess another type after a permission error');
    if (!contentUrl && type === 'article') contentUrl = `https://zhuanlan.zhihu.com/p/${id}`;
    if (!contentUrl && ['pin', 'zvideo'].includes(type)) contentUrl = `https://www.zhihu.com/${type}/${id}`;
    return { type, id, contentUrl, statsUrl: `https://www.zhihu.com/creator/analytics/work/${type}/${id}` };
}

const COUNTERS = { views: 'pv', plays: 'play', impressions: 'show', upvotes: 'upvote', comments: 'comment', likes: 'like', collections: 'collect', shares: 'share', reposts: 're_pin', new_follows: 'new_follow_uv' };
function count(value, label) {
    if (value === null || value === undefined) return null;
    if ((typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new CommandExecutionError(`Invalid creator metric: ${label}`);
    return Number(value);
}
function decimal(value, label, percent = false) {
    if (value === undefined || value === null || ['--', 'NaN%', '计算中'].includes(value)) return null;
    const text = percent && typeof value === 'string' ? value.replace(/%$/, '') : value;
    if ((typeof text !== 'number' && !(typeof text === 'string' && /^\d+(?:\.\d+)?$/.test(text))) || !Number.isFinite(Number(text)) || Number(text) < 0) throw new CommandExecutionError(`Invalid creator metric: ${label}`);
    return Number(text);
}
export function normalizeCreatorMetrics(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.values(COUNTERS).some(key => raw[key] !== undefined && raw[key] !== null)) throw new CommandExecutionError('Creator response contains no valid metric object');
    return { ...Object.fromEntries(Object.entries(COUNTERS).map(([key, field]) => [key, count(raw[field], field)])),
        avg_read_seconds: decimal(raw.avg_read_duration, 'avg_read_duration'),
        finish_read_pct: decimal(raw.advanced?.finish_read_percent, 'finish_read_percent', true),
        positive_interact_pct: decimal(raw.advanced?.positive_interact_percent, 'positive_interact_percent', true) };
}
export function normalizeCreatorStats(aggregate, daily, target, range, sampledAt = new Date().toISOString()) {
    const content = aggregate?.[target.type];
    if (!content) throw new EmptyResultError('zhihu creator analytics', 'No identifiable content is available for this account and type; zero metrics are not proof of a valid work');
    const exactIds = [content?.url_token, content?.id].filter(x => typeof x === 'string' && x);
    if (!content || !exactIds.includes(target.id) || exactIds.some(x => x !== target.id)) throw new CommandExecutionError('Creator response does not contain the requested exact content identity');
    if (!Array.isArray(daily)) throw new CommandExecutionError('Creator daily response must be an array');
    const seen = new Set();
    const trend = daily.map(row => {
        const day = row?.p_date;
        try { dateMs(day, 'daily date'); } catch { throw new CommandExecutionError('Creator daily response contains an invalid date'); }
        if (day < range.start || day > range.end || seen.has(day)) throw new CommandExecutionError('Creator daily response contains duplicate or out-of-range dates');
        seen.add(day); return { date: day, ...normalizeCreatorMetrics(row) };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return [{ id: target.id, platform_type: target.type,
        media_type: target.type === 'zvideo' || content.video ? 'video' : target.type === 'pin' ? (content.images?.length ? 'image' : 'text') : 'text',
        content_url: target.contentUrl, stats_url: target.statsUrl, start_date: range.start, end_date: range.end,
        aggregate_scope: range.scope, overview: normalizeCreatorMetrics(aggregate), trend,
        content_mark: aggregate.content_mark ?? null, sampled_at: sampledAt }];
}
