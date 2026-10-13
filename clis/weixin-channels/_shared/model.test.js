import { describe, expect, it } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
    normalizeOverview,
    normalizeDetail,
    normalizePost,
    normalizeSources,
    normalizeTrend,
    resolveDateRange,
} from './model.js';

const NOW = new Date('2026-10-12T16:30:00Z');
const TWO_DAYS = {
    startDate: '2026-02-28', endDate: '2026-03-01', days: 2,
    startTs: 1772208000, endTs: 1772294400,
};

describe('weixin-channels date ranges', () => {
    it('uses Shanghai yesterday, independent of the machine timezone', () => {
        expect(resolveDateRange({}, NOW)).toEqual({
            startDate: '2026-10-06', endDate: '2026-10-12', days: 7,
            startTs: 1791216000, endTs: 1791734400,
        });
    });

    it('allows a command-specific default window', () => {
        expect(resolveDateRange({}, NOW, 1)).toEqual({
            startDate: '2026-10-12', endDate: '2026-10-12', days: 1,
            startTs: 1791734400, endTs: 1791734400,
        });
    });

    it('accepts a numeric days argument from the CLI', () => {
        expect(resolveDateRange({ days: '7' }, NOW).startDate).toBe('2026-10-06');
    });

    it('counts custom dates inclusively across a month boundary', () => {
        expect(resolveDateRange({
            'start-date': '2026-02-28', 'end-date': '2026-03-01',
        }, NOW)).toEqual(TWO_DAYS);
    });

    it('accepts a real leap day and older dates without an invented retention floor', () => {
        expect(resolveDateRange({
            'start-date': '2024-02-29', 'end-date': '2024-02-29',
        }, NOW)).toEqual({
            startDate: '2024-02-29', endDate: '2024-02-29', days: 1,
            startTs: 1709136000, endTs: 1709136000,
        });
    });

    it('allows exactly 366 days', () => {
        expect(resolveDateRange({
            'start-date': '2024-01-01', 'end-date': '2024-12-31',
        }, NOW).days).toBe(366);
        expect(resolveDateRange({ days: 366 }, NOW).days).toBe(366);
    });

    it.each([0, -1, 1.5, 367, '1.5', 'abc', '', null, Infinity, true])(
        'rejects invalid --days %s', (days) => {
            expect(() => resolveDateRange({ days }, NOW)).toThrow(ArgumentError);
        },
    );

    it.each([
        { 'start-date': '2026-02-28' },
        { 'end-date': '2026-03-01' },
        { 'start-date': '2026-02-29', 'end-date': '2026-03-01' },
        { 'start-date': '2026-2-28', 'end-date': '2026-03-01' },
        { 'start-date': '2026-04-31', 'end-date': '2026-05-01' },
        { 'start-date': '2026-03-02', 'end-date': '2026-03-01' },
        { 'start-date': '2026-10-13', 'end-date': '2026-10-13' },
        { 'start-date': '2026-10-12', 'end-date': '2026-10-14' },
        { 'start-date': '2024-01-01', 'end-date': '2025-01-01' },
        { days: 7, 'start-date': '2026-02-28', 'end-date': '2026-03-01' },
    ])('rejects malformed, incomplete or conflicting dates: %j', (args) => {
        expect(() => resolveDateRange(args, NOW)).toThrow(ArgumentError);
    });
});

describe('weixin-channels daily metrics', () => {
    const data = {
        totalData: {
            browse: [12, '20'], like: ['3', 0], fav: [1, '2'], comment: [0, '4'],
            forwardAggregation: ['5', 1], follow: [2, 0],
        },
        username: 'private-account', token: 'private-token',
    };

    it('maps daily arrays in date order, keeping recommendations distinct from likes', () => {
        expect(normalizeTrend(data, TWO_DAYS)).toEqual([
            { date: '2026-02-28', views: 12, recommendations: 3, likes: 1, comments: 0, shares: 5, follows: 2 },
            { date: '2026-03-01', views: 20, recommendations: 0, likes: 2, comments: 4, shares: 1, follows: 0 },
        ]);
    });

    it.each([
        { key: 'like', field: 'recommendations' },
        { key: 'fav', field: 'likes' },
        { key: 'comment', field: 'comments' },
        { key: 'follow', field: 'follows' },
    ])('preserves signed daily net changes for $key', ({ key, field }) => {
        const rows = normalizeTrend({ totalData: { [key]: [-2, '-1'] } }, TWO_DAYS);
        expect(rows[0]).toMatchObject({ date: '2026-02-28', [field]: -2 });
        expect(rows[1]).toMatchObject({ date: '2026-03-01', [field]: -1 });
    });

    it('sums daily cancellation and deletion into negative overview net changes', () => {
        expect(normalizeOverview({ totalData: {
            like: [-3, '1'], fav: ['-2', 1], comment: [1, '-4'], follow: ['-1', -2],
        } }, TWO_DAYS)).toEqual({
            start_date: '2026-02-28', end_date: '2026-03-01', views: null,
            recommendations: -2, likes: -1, comments: -3, shares: null, follows: -3,
        });
    });

    it.each(['browse', 'forwardAggregation'])('continues rejecting negative daily $s totals', (key) => {
        expect(() => normalizeTrend({ totalData: { [key]: ['-1', 0] } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it.each([-9007199254740992, '-9007199254740992', '-1.5', '--1'])('rejects invalid signed net changes: %s', (value) => {
        expect(() => normalizeTrend({ totalData: { follow: [value, 0] } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects an unsafe negative net aggregate', () => {
        expect(() => normalizeOverview({ totalData: {
            follow: [-Number.MAX_SAFE_INTEGER, -1],
        } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('sums signed safe integers exactly when large net changes cancel', () => {
        expect(normalizeOverview({ totalData: {
            follow: [Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER],
        } }, { ...TWO_DAYS, startDate: '2026-02-27', days: 3, startTs: 1772121600 }).follows).toBe(2);
    });

    it('distinguishes empty or missing series from actual zero values', () => {
        expect(normalizeTrend({ totalData: { browse: [], fav: [0, '0'] } }, TWO_DAYS)).toEqual([
            { date: '2026-02-28', views: null, recommendations: null, likes: 0, comments: null, shares: null, follows: null },
            { date: '2026-03-01', views: null, recommendations: null, likes: 0, comments: null, shares: null, follows: null },
        ]);
    });

    it('sums the requested daily values into a whitelisted overview', () => {
        expect(normalizeOverview(data, TWO_DAYS)).toEqual({
            start_date: '2026-02-28', end_date: '2026-03-01', views: 32,
            recommendations: 3, likes: 3, comments: 4, shares: 6, follows: 2,
        });
    });

    it('leaves wholly absent metrics null in the overview', () => {
        expect(normalizeOverview({ totalData: { browse: [], fav: [0, 0] } }, TWO_DAYS)).toEqual({
            start_date: '2026-02-28', end_date: '2026-03-01', views: null,
            recommendations: null, likes: 0, comments: null, shares: null, follows: null,
        });
    });

    it.each([{ browse: [1] }, { browse: [1, 2, 3] }, { browse: '12' }, { browse: {} }])('rejects unexpected series shapes: %j', ({ browse }) => {
        expect(() => normalizeTrend({ totalData: { browse } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it.each(['not-a-number', '', ' ', '1.2', true, {}, NaN, Infinity, 9007199254740992, '9007199254740992']) (
        'rejects invalid or unsafe counters: %s', (value) => {
            expect(() => normalizeTrend({ totalData: { browse: [value, 0] } }, TWO_DAYS)).toThrow(CommandExecutionError);
        },
    );

    it('rejects missing points inside a nonempty series instead of claiming zero', () => {
        expect(() => normalizeTrend({ totalData: { browse: [1, null] } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects unsafe aggregate sums', () => {
        expect(() => normalizeOverview({
            totalData: { browse: [Number.MAX_SAFE_INTEGER, 1] },
        }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects a malformed totalData object', () => {
        expect(() => normalizeTrend({ totalData: [] }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects sparse daily arrays with missing points', () => {
        expect(() => normalizeTrend({ totalData: { browse: [1, ,] } }, TWO_DAYS)).toThrow(CommandExecutionError);
    });
});

describe('weixin-channels source metrics', () => {
    it('retains API source granularity instead of merging labels', () => {
        expect(normalizeSources({
            dataByTabtype: [
                { tabType: 1, tabTypeName: '推荐', data: { browse: [10, '2'], like: [1, 0], fav: [] }, username: 'private' },
                { tabType: 12, tabTypeName: '朋友赞过', data: { browse: ['3', 4], fav: [0, 1] } },
            ],
            token: 'private-token',
        }, TWO_DAYS)).toEqual([
            { start_date: '2026-02-28', end_date: '2026-03-01', views: 12, recommendations: 1, likes: null,
                comments: null, shares: null, follows: null, source_id: 1, source: '推荐', views_pct: null },
            { start_date: '2026-02-28', end_date: '2026-03-01', views: 7, recommendations: null, likes: 1,
                comments: null, shares: null, follows: null, source_id: 12, source: '朋友赞过', views_pct: null },
        ]);
    });

    it('returns no rows for an explicitly empty source array', () => {
        expect(normalizeSources({ dataByTabtype: [] }, TWO_DAYS)).toEqual([]);
    });

    it('sums signed daily changes independently for each source', () => {
        expect(normalizeSources({ dataByTabtype: [{
            tabType: 1, tabTypeName: '推荐',
            data: { like: ['-2', 1], fav: [1, '-3'], comment: [-3, '2'], follow: ['-1', 0] },
        }] }, TWO_DAYS)).toEqual([{
            start_date: '2026-02-28', end_date: '2026-03-01', views: null,
            recommendations: -1, likes: -2, comments: -1, shares: null, follows: -1,
            source_id: 1, source: '推荐', views_pct: null,
        }]);
    });

    it('computes rounded source shares using the same-period total without merging names', () => {
        const rows = normalizeSources({
            totalData: { browse: [3, '3'] },
            dataByTabtype: [
                { tabType: 1, tabTypeName: '推荐', data: { browse: [1, '1'], follow: [-1, 0] } },
                { tabType: 2, tabTypeName: '推荐', data: { browse: ['2', 2] } },
            ],
        }, TWO_DAYS);
        expect(rows).toEqual([
            { start_date: '2026-02-28', end_date: '2026-03-01', views: 2, recommendations: null, likes: null,
                comments: null, shares: null, follows: -1, source_id: 1, source: '推荐', views_pct: 33.33 },
            { start_date: '2026-02-28', end_date: '2026-03-01', views: 4, recommendations: null, likes: null,
                comments: null, shares: null, follows: null, source_id: 2, source: '推荐', views_pct: 66.67 },
        ]);
    });

    it.each([
        { totalData: undefined }, { totalData: {} }, { totalData: { browse: [] } },
        { totalData: { browse: [0, '0'] } },
    ])('leaves shares unknown when total views are unavailable or zero: %j', (data) => {
        const rows = normalizeSources({ ...data, dataByTabtype: [
            { tabType: 1, tabTypeName: '推荐', data: { browse: [1, 2] } },
        ] }, TWO_DAYS);
        expect(rows[0]).toMatchObject({ views: 3, views_pct: null });
    });

    it('keeps zero source shares distinct from missing source views', () => {
        const rows = normalizeSources({
            totalData: { browse: [4, 6] },
            dataByTabtype: [
                { tabType: 1, tabTypeName: '推荐', data: { browse: ['0', 0] } },
                { tabType: 2, tabTypeName: '搜索', data: { browse: [] } },
                { tabType: 3, tabTypeName: '其他', data: {} },
            ],
        }, TWO_DAYS);
        expect(rows.map(({ views, views_pct }) => ({ views, views_pct }))).toEqual([
            { views: 0, views_pct: 0 }, { views: null, views_pct: null }, { views: null, views_pct: null },
        ]);
    });

    it('does not renormalize known sources to 100 percent when another source is unknown', () => {
        const rows = normalizeSources({
            totalData: { browse: [4, 6] },
            dataByTabtype: [
                { tabType: 1, tabTypeName: '推荐', data: { browse: [2, 4] } },
                { tabType: 2, tabTypeName: '其他', data: {} },
            ],
        }, TWO_DAYS);
        expect(rows.map(({ source_id, views_pct }) => ({ source_id, views_pct }))).toEqual([
            { source_id: 1, views_pct: 60 }, { source_id: 2, views_pct: null },
        ]);
    });

    it.each([{}, { dataByTabtype: null }, { dataByTabtype: {} }])('rejects an absent or malformed sources array: %j', (data) => {
        expect(() => normalizeSources(data, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects a source with a truncated daily series', () => {
        expect(() => normalizeSources({
            dataByTabtype: [{ tabType: 1, tabTypeName: '推荐', data: { browse: [5] } }],
        }, TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('rejects a source without its business identity', () => {
        expect(() => normalizeSources({
            dataByTabtype: [{ data: { browse: [5, 0] } }],
        }, TWO_DAYS)).toThrow(CommandExecutionError);
    });
});

describe('weixin-channels post metrics', () => {
    const post = {
        objectId: '18446744073709551615', createTime: 1791734400,
        desc: { description: '测试视频标题', username: 'private-account' },
        readCount: '12', likeCount: 3, favCount: '2', commentCount: 0,
        forwardAggregationCount: 5, followCount: 1, fullPlayRate: 0.625,
        avgPlayTimeSec: 2.75, forwardCount: 4, ringsetCount: 0, statusrefCount: 1,
        snscoverCount: 2, wecomLinkClickCount: 3, wecomLinkClickUv: 2,
        wecomContactAddCount: 1, wecomContactAddUv: 1,
        username: 'private-account', token: 'private-token', cookie: 'private-cookie', raw: { token: 'private' },
    };

    it('keeps the full video id and emits only the approved business fields', () => {
        expect(normalizePost(post)).toEqual({
            id: '18446744073709551615', title: '测试视频标题', published_at: '2026-10-12T00:00:00+08:00',
            views: 12, recommendations: 3, likes: 2, comments: 0, shares: 5, follows: 1,
            completion_rate: 62.5, avg_play_seconds: 2.75, chat_shares: 4,
            ringtone_sets: 0, status_sets: 1, cover_sets: 2,
            wecom_link_clicks: 3, wecom_link_visitors: 2,
            wecom_contact_adds: 1, wecom_contact_visitors: 1,
        });
    });

    it('preserves zero while leaving unreturned metrics null', () => {
        expect(normalizePost({ objectId: '1', desc: '无指标', readCount: 0 })).toEqual({
            id: '1', title: '无指标', published_at: null, views: 0,
            recommendations: null, likes: null, comments: null, shares: null, follows: null,
            completion_rate: null, avg_play_seconds: null, chat_shares: null,
            ringtone_sets: null, status_sets: null, cover_sets: null,
            wecom_link_clicks: null, wecom_link_visitors: null,
            wecom_contact_adds: null, wecom_contact_visitors: null,
        });
    });

    it('ignores unknown title shapes without exposing the nested object', () => {
        expect(normalizePost({ objectId: '1', desc: { unknown: { username: 'secret' } } }).title).toBe('');
    });

    it.each(['garbage', '', false, 9007199254740992, '9007199254740992', 1.5])(
        'rejects a malformed post count: %s', (readCount) => {
            expect(() => normalizePost({ objectId: '1', readCount })).toThrow(CommandExecutionError);
        },
    );

    it('rejects a numeric id whose precision has already been lost', () => {
        expect(() => normalizePost({ objectId: 9007199254740992 })).toThrow(CommandExecutionError);
    });

    it.each([{}, null, []])('rejects a post without a stable identity: %j', (item) => {
        expect(() => normalizePost(item)).toThrow(CommandExecutionError);
    });

    it('rejects a malformed publishing timestamp', () => {
        expect(() => normalizePost({ objectId: '1', createTime: 'yesterday' })).toThrow(CommandExecutionError);
    });

    it('rejects invalid decimal playback metrics', () => {
        expect(() => normalizePost({ objectId: '1', fullPlayRate: NaN })).toThrow(CommandExecutionError);
        expect(() => normalizePost({ objectId: '1', avgPlayTimeSec: 'bad' })).toThrow(CommandExecutionError);
    });

    it('reports completion as a percentage and rounds playback seconds to two decimals', () => {
        expect(normalizePost({ objectId: '1', fullPlayRate: 0.01951219, avgPlayTimeSec: 9.37317 })).toMatchObject({
            completion_rate: 1.95, avg_play_seconds: 9.37,
        });
    });

    it('rejects completion ratios outside the verified API unit', () => {
        expect(() => normalizePost({ objectId: '1', fullPlayRate: 1.5 })).toThrow(CommandExecutionError);
    });

    it.each(['likeCount', 'favCount', 'commentCount', 'followCount'])('continues rejecting negative cumulative $s counts', (key) => {
        expect(() => normalizePost({ objectId: '1', [key]: '-1' })).toThrow(CommandExecutionError);
    });
});

describe('weixin-channels post detail', () => {
    const data = {
        feedData: [{
            totalData: { browse: [12, '20'], like: [3, 0], fav: [1, 2], comment: [0, 4], forwardAggregation: [5, 1], follow: [2, 0] },
            dataByTabtype: [{ tabType: 1, tabTypeName: '推荐', data: { browse: [10, '2'] } }],
            username: 'private-account',
        }],
        dataByFanstype: [{ username: 'private-account', unknown: 'unverified' }],
        notExistFansData: true, token: 'private-token',
    };
    const retention = {
        baseResp: { errcode: 0, errmsg: '' }, items: [{ rate: 1, sec: 0 }, { rate: 0.04411764705882353, sec: 21 }, { rate: 0, sec: 107 }],
        maxLostRateSec: 21, mediaType: 4, videoLen: 107, username: 'private-account',
    };

    it('normalizes the verified single-feed envelope and retention percentages', () => {
        expect(normalizeDetail(data, retention, '18446744073709551615', TWO_DAYS)).toEqual({
            id: '18446744073709551615', start_date: '2026-02-28', end_date: '2026-03-01',
            overview: { start_date: '2026-02-28', end_date: '2026-03-01', views: 32, recommendations: 3, likes: 3, comments: 4, shares: 6, follows: 2 },
            trend: [
                { date: '2026-02-28', views: 12, recommendations: 3, likes: 1, comments: 0, shares: 5, follows: 2 },
                { date: '2026-03-01', views: 20, recommendations: 0, likes: 2, comments: 4, shares: 1, follows: 0 },
            ],
            sources: [{ start_date: '2026-02-28', end_date: '2026-03-01', views: 12, recommendations: null, likes: null,
                comments: null, shares: null, follows: null, source_id: 1, source: '推荐', views_pct: 37.5 }],
            data_details: [
                { date: '2026-02-28', source_id: 1, source: '推荐', views: 10, recommendations: null, likes: null,
                    comments: null, shares: null, follows: null },
                { date: '2026-03-01', source_id: 1, source: '推荐', views: 2, recommendations: null, likes: null,
                    comments: null, shares: null, follows: null },
            ],
            retention: {
                video_seconds: 107, max_loss_second: 21,
                points: [{ second: 0, retained_pct: 100 }, { second: 21, retained_pct: 4.41 }, { second: 107, retained_pct: 0 }],
            },
            fans_breakdown_available: false,
        });
    });

    it('reports the verified fans-availability flag without forwarding the raw breakdown', () => {
        const result = normalizeDetail({ ...data, notExistFansData: false }, retention, '1', TWO_DAYS);
        expect(result.fans_breakdown_available).toBe(true);
        expect(result).not.toHaveProperty('dataByFanstype');
    });

    it('flattens multiple source series by ascending date while preserving source order and net values', () => {
        const detailData = { feedData: [{
            totalData: { browse: [3, 5] },
            dataByTabtype: [
                { tabType: 12, tabTypeName: '推荐', data: { browse: [1, '2'], like: ['-1', 0], fav: [0, '-2'] }, username: 'private' },
                { tabType: 1, tabTypeName: '推荐', data: { browse: ['2', 3], comment: [-1, 0], forwardAggregation: [0, 1], follow: ['-2', 1] } },
            ],
        }] };
        expect(normalizeDetail(detailData, retention, '1', TWO_DAYS).data_details).toEqual([
            { date: '2026-02-28', source_id: 12, source: '推荐', views: 1, recommendations: -1, likes: 0, comments: null, shares: null, follows: null },
            { date: '2026-02-28', source_id: 1, source: '推荐', views: 2, recommendations: null, likes: null, comments: -1, shares: 0, follows: -2 },
            { date: '2026-03-01', source_id: 12, source: '推荐', views: 2, recommendations: 0, likes: -2, comments: null, shares: null, follows: null },
            { date: '2026-03-01', source_id: 1, source: '推荐', views: 3, recommendations: null, likes: null, comments: 0, shares: 1, follows: 1 },
        ]);
    });

    it('returns empty source aggregates and data details for an explicitly empty source array', () => {
        const result = normalizeDetail({ feedData: [{ totalData: { browse: [1, 2] }, dataByTabtype: [] }] }, retention, '1', TWO_DAYS);
        expect(result).toMatchObject({ sources: [], data_details: [] });
    });

    it('retains daily rows with unavailable source metrics instead of inventing zero', () => {
        const result = normalizeDetail({ feedData: [{
            totalData: { browse: [1, 2] },
            dataByTabtype: [{ tabType: 1, tabTypeName: '其他', data: { browse: [], like: [0, '0'] } }],
        }] }, retention, '1', TWO_DAYS);
        expect(result.data_details).toEqual([
            { date: '2026-02-28', source_id: 1, source: '其他', views: null, recommendations: 0, likes: null, comments: null, shares: null, follows: null },
            { date: '2026-03-01', source_id: 1, source: '其他', views: null, recommendations: 0, likes: null, comments: null, shares: null, follows: null },
        ]);
        expect(result.sources[0].views_pct).toBeNull();
    });

    it.each([{ feedData: [] }, { feedData: [{}, {}] }, { feedData: {} }, {}, { feedData: [null] }]) (
        'rejects an absent or ambiguous single-feed response: %j', (invalid) => {
            expect(() => normalizeDetail(invalid, retention, '1', TWO_DAYS)).toThrow(CommandExecutionError);
        },
    );

    it.each([null, undefined, {}, { items: {} }])('rejects malformed retention: %j', (invalid) => {
        expect(() => normalizeDetail(data, invalid, '1', TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it.each([
        { rate: 2, sec: 0 }, { rate: NaN, sec: 0 }, { rate: 1, sec: 'bad' }, { sec: 0 }, { rate: 1 },
    ])('rejects a malformed retention point: %j', (point) => {
        expect(() => normalizeDetail(data, { ...retention, items: [point] }, '1', TWO_DAYS)).toThrow(CommandExecutionError);
    });

    it('continues rejecting negative retention seconds', () => {
        expect(() => normalizeDetail(data, { ...retention, items: [{ sec: '-1', rate: 1 }] }, '1', TWO_DAYS)).toThrow(CommandExecutionError);
    });
});
