import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_METRICS = {
    views: 'browse',
    recommendations: 'like',
    likes: 'fav',
    comments: 'comment',
    shares: 'forwardAggregation',
    follows: 'follow',
};
// Daily engagement is added actions minus cancellations or deletions.
const DAILY_NET_METRICS = new Set(['like', 'fav', 'comment', 'follow']);
const POST_COUNTERS = {
    views: 'readCount',
    recommendations: 'likeCount',
    likes: 'favCount',
    comments: 'commentCount',
    shares: 'forwardAggregationCount',
    follows: 'followCount',
    chat_shares: 'forwardCount',
    ringtone_sets: 'ringsetCount',
    status_sets: 'statusrefCount',
    cover_sets: 'snscoverCount',
    wecom_link_clicks: 'wecomLinkClickCount',
    wecom_link_visitors: 'wecomLinkClickUv',
    wecom_contact_adds: 'wecomContactAddCount',
    wecom_contact_visitors: 'wecomContactAddUv',
};

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function calendarDateMs(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ArgumentError(`${label} must be YYYY-MM-DD`);
    }
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
        throw new ArgumentError(`${label} must be a valid calendar date`);
    }
    return ms;
}

function positiveDays(value) {
    const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
    const days = validType ? Number(value) : NaN;
    if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
        throw new ArgumentError('--days must be an integer between 1 and 366');
    }
    return days;
}

/** Inclusive dates, expressed as Shanghai midnight Unix seconds. */
export function resolveDateRange(args = {}, now = new Date(), defaultDays = 7) {
    if (!isRecord(args) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new ArgumentError('Invalid date range arguments');
    }
    const today = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
    const todayMs = calendarDateMs(today, 'today');
    const hasStart = args['start-date'] !== undefined;
    const hasEnd = args['end-date'] !== undefined;
    const hasDays = args.days !== undefined;
    if (hasStart !== hasEnd) {
        throw new ArgumentError('--start-date and --end-date must be supplied together');
    }
    if (hasDays && hasStart) {
        throw new ArgumentError('--days cannot be combined with --start-date and --end-date');
    }

    let startMs;
    let endMs;
    let days;
    if (hasStart) {
        startMs = calendarDateMs(args['start-date'], '--start-date');
        endMs = calendarDateMs(args['end-date'], '--end-date');
        if (startMs > endMs) throw new ArgumentError('--start-date must not be after --end-date');
        if (endMs >= todayMs) throw new ArgumentError('--end-date must be before today in Asia/Shanghai');
        days = (endMs - startMs) / DAY_MS + 1;
        if (days > 366) throw new ArgumentError('The date range must not exceed 366 days');
    } else {
        days = positiveDays(hasDays ? args.days : defaultDays);
        endMs = todayMs - DAY_MS;
        startMs = endMs - (days - 1) * DAY_MS;
    }
    return {
        startDate: new Date(startMs).toISOString().slice(0, 10),
        endDate: new Date(endMs).toISOString().slice(0, 10),
        days,
        startTs: (startMs - SHANGHAI_OFFSET_MS) / 1000,
        endTs: (endMs - SHANGHAI_OFFSET_MS) / 1000,
    };
}

function counter(value, label, optional = true, allowNegative = false) {
    if (optional && (value === undefined || value === null)) return null;
    const numberString = allowNegative ? /^-?\d+$/ : /^\d+$/;
    const validType = typeof value === 'number' || (typeof value === 'string' && numberString.test(value));
    const number = validType ? Number(value) : NaN;
    if (!Number.isSafeInteger(number) || (!allowNegative && number < 0)) {
        throw new CommandExecutionError(`Weixin Channels returned an invalid ${label} count`);
    }
    return number;
}

function decimalMetric(value, label, optional = true) {
    if (optional && (value === undefined || value === null)) return null;
    const validType = typeof value === 'number'
        || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
    const number = validType ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
        throw new CommandExecutionError(`Weixin Channels returned an invalid ${label} metric`);
    }
    return number;
}

function roundTwo(value) {
    return value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
}

function percentage(value, label, optional = true) {
    const ratio = decimalMetric(value, label, optional);
    if (ratio === null) return null;
    if (ratio > 1) throw new CommandExecutionError(`Weixin Channels returned an invalid ${label} ratio`);
    return roundTwo(ratio * 100);
}

function dailySeries(data, range) {
    if (!isRecord(data) || (data.totalData != null && !isRecord(data.totalData))) {
        throw new CommandExecutionError('Weixin Channels returned malformed daily metrics');
    }
    const metrics = data.totalData ?? {};
    return Object.fromEntries(Object.entries(DAILY_METRICS).map(([name, key]) => {
        const values = metrics[key];
        if (values === undefined || values === null) return [name, null];
        if (!Array.isArray(values) || (values.length !== 0 && values.length !== range.days)) {
            throw new CommandExecutionError(`Weixin Channels returned an unexpected ${key} series length`);
        }
        if (!values.length) return [name, null];
        return [name, Array.from(values, (value) => counter(value, key, false, DAILY_NET_METRICS.has(key)))];
    }));
}

/** API like = heart/recommendation; API fav = thumb/like. */
export function normalizeTrend(data, range) {
    const series = dailySeries(data, range);
    const startMs = Date.parse(`${range.startDate}T00:00:00Z`);
    return Array.from({ length: range.days }, (_, index) => ({
        date: new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
        ...Object.fromEntries(Object.entries(series).map(([name, values]) => [name, values === null ? null : values[index]])),
    }));
}

export function normalizeOverview(data, range) {
    const series = dailySeries(data, range);
    return {
        start_date: range.startDate,
        end_date: range.endDate,
        ...Object.fromEntries(Object.entries(series).map(([name, values]) => {
            if (values === null) return [name, null];
            // Exact addition also preserves safe results after large signed changes cancel.
            const sum = Number(values.reduce((total, value) => total + BigInt(value), 0n));
            if (!Number.isSafeInteger(sum)) {
                throw new CommandExecutionError(`Weixin Channels returned an unsafe ${name} total`);
            }
            return [name, sum];
        })),
    };
}

export function normalizeSources(data, range) {
    if (!isRecord(data) || !Array.isArray(data.dataByTabtype)) {
        throw new CommandExecutionError('Weixin Channels returned malformed source metrics');
    }
    const totalViews = normalizeOverview(data, range).views;
    return data.dataByTabtype.map((item) => {
        if (!isRecord(item) || item.tabType == null || typeof item.tabTypeName !== 'string' || !isRecord(item.data)) {
            throw new CommandExecutionError('Weixin Channels returned a source without its identity or metrics');
        }
        if (typeof item.tabType !== 'string' && !(Number.isSafeInteger(item.tabType) && item.tabType >= 0)) {
            throw new CommandExecutionError('Weixin Channels returned an invalid source identity');
        }
        const overview = normalizeOverview({ totalData: item.data }, range);
        return {
            ...overview,
            source_id: item.tabType,
            source: item.tabTypeName,
            views_pct: totalViews === null || totalViews === 0 || overview.views === null
                ? null : roundTwo(overview.views / totalViews * 100),
        };
    });
}

function postId(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    throw new CommandExecutionError('Weixin Channels returned a post without a stable objectId');
}

function publishedAt(value) {
    const seconds = counter(value, 'createTime');
    if (seconds === null) return null;
    const ms = seconds * 1000 + SHANGHAI_OFFSET_MS;
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
        throw new CommandExecutionError('Weixin Channels returned an invalid createTime timestamp');
    }
    return `${new Date(ms).toISOString().slice(0, 19)}+08:00`;
}

export function normalizePost(item) {
    if (!isRecord(item)) throw new CommandExecutionError('Weixin Channels returned a malformed post');
    const title = typeof item.desc === 'string' ? item.desc
        : (typeof item.desc?.description === 'string' ? item.desc.description : '');
    return {
        id: postId(item.objectId),
        title,
        published_at: publishedAt(item.createTime),
        ...Object.fromEntries(Object.entries(POST_COUNTERS).map(([name, key]) => [name, counter(item[key], key)])),
        // The verified API unit is a 0..1 ratio; business output uses percent.
        completion_rate: percentage(item.fullPlayRate, 'fullPlayRate'),
        avg_play_seconds: roundTwo(decimalMetric(item.avgPlayTimeSec, 'avgPlayTimeSec')),
    };
}

function normalizeRetention(data) {
    if (!isRecord(data) || !Array.isArray(data.items)) {
        throw new CommandExecutionError('Weixin Channels returned malformed retention metrics');
    }
    return {
        video_seconds: counter(data.videoLen, 'videoLen', false),
        max_loss_second: counter(data.maxLostRateSec, 'maxLostRateSec', false),
        points: Array.from(data.items, (item) => {
            if (!isRecord(item)) throw new CommandExecutionError('Weixin Channels returned a malformed retention point');
            return {
                second: counter(item.sec, 'retention second', false),
                retained_pct: percentage(item.rate, 'retention', false),
            };
        }),
    };
}

export function normalizeDetail(data, retention, id, range) {
    if (!isRecord(data) || !Array.isArray(data.feedData) || data.feedData.length !== 1 || !isRecord(data.feedData[0])) {
        throw new CommandExecutionError('Weixin Channels returned an unexpected single-post detail payload');
    }
    const feed = data.feedData[0];
    const sources = normalizeSources(feed, range);
    const trend = normalizeTrend(feed, range);
    const sourceTrends = feed.dataByTabtype.map((item) => normalizeTrend({ totalData: item.data }, range));
    return {
        id: postId(id),
        start_date: range.startDate,
        end_date: range.endDate,
        overview: normalizeOverview(feed, range),
        trend,
        sources,
        data_details: trend.flatMap((_, dayIndex) => sources.map((source, sourceIndex) => {
            const { date, ...metrics } = sourceTrends[sourceIndex][dayIndex];
            return { date, source_id: source.source_id, source: source.source, ...metrics };
        })),
        retention: normalizeRetention(retention),
        fans_breakdown_available: !data.notExistFansData,
    };
}
