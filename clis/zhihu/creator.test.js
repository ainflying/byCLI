import { describe, expect, it, vi } from 'vitest';
import { creatorTarget, creatorDateRange, normalizeCreatorStats } from './creator-model.js';
import { fetchCreatorStats } from './creator-client.js';
import { getRegistry } from '@sovovs/bycli/registry';
import './content-stats.js';
const id = '2095492373581251925';
const target = creatorTarget(`pin:${id}`);
const range = { start: '2026-10-13', end: '2026-10-19', scope: 'cumulative' };
// Synthetic minimal response contract; not a captured platform acceptance fixture.
const aggr = () => ({ pin: { id, url_token: id, video: {} }, pv: 7, play: 0, advanced: { finish_read_percent: 'NaN%' } });
describe('Zhihu creator target and dates', () => {
    it('keeps the real pin type and precise ID for video content', () => {
        expect(creatorTarget(`https://www.zhihu.com/pin/${id}`)).toEqual(target);
        expect(creatorTarget(`https://www.zhihu.com/creator/analytics/work/pin/${id}`)).toEqual(target);
        expect(creatorTarget(`answer:21929143:${id}`).contentUrl).toBe(`https://www.zhihu.com/question/21929143/answer/${id}`);
    });
    it.each([() => creatorTarget(id), () => creatorTarget(`pin:${id}`, 'zvideo'), () => creatorTarget(`https://evil.example/pin/${id}`), () => creatorTarget(`https://www.zhihu.com.evil.example/pin/${id}`), () => creatorTarget(`https://user@www.zhihu.com/pin/${id}`)])('rejects ambiguous or mismatched targets', fn => expect(fn).toThrow());
    it('includes Shanghai today and handles midnight and leap days', () => {
        expect(creatorDateRange({}, new Date('2026-10-18T16:01:00Z'))).toEqual(range);
        expect(creatorDateRange({ days: 2 }, new Date('2024-02-29T02:00:00Z')).start).toBe('2024-02-28');
    });
    it.each([{ days: 0 }, { days: 367 }, { days: 1.5 }, { 'start-date': '2026-10-13' }, { 'start-date': '2026-02-30', 'end-date': '2026-10-19' }, { days: 7, 'start-date': '2026-10-13', 'end-date': '2026-10-19' }, { 'start-date': '2026-10-20', 'end-date': '2026-10-20' }])('rejects invalid ranges %j', args => expect(() => creatorDateRange(args, new Date('2026-10-19T02:00:00Z'))).toThrow());
});
describe('Zhihu creator result contract', () => {
    it('keeps plays distinct from views, missing values null and actual zero intact', () => {
        const [row] = normalizeCreatorStats(aggr(), [{ p_date: '2026-10-19', pv: 7, play: 0 }], target, range, 'sample');
        expect(row).toMatchObject({ id, platform_type: 'pin', media_type: 'video', overview: { views: 7, plays: 0, likes: null, finish_read_pct: null }, trend: [{ date: '2026-10-19', views: 7, plays: 0 }] });
        expect(Object.keys(row)).toEqual(getRegistry().get('zhihu/content-stats').columns);
    });
    it('accepts an exact string url_token despite a lossy numeric id, but rejects conflicting strings', () => {
        const body = aggr(); body.pin.id = Number(id);
        expect(normalizeCreatorStats(body, [], target, range)[0].id).toBe(id);
        body.pin.id = '1'; expect(() => normalizeCreatorStats(body, [], target, range)).toThrow('identity');
        body.pin = { id: Number(id) }; expect(() => normalizeCreatorStats(body, [], target, range)).toThrow('identity');
    });
    it.each([
        [{ p_date: '2026-10-19', pv: 0 }, { p_date: '2026-10-19', pv: 1 }],
        [{ p_date: '2026-10-12', pv: 1 }], [{ p_date: 'not-a-day', pv: 0 }],
        [{ p_date: '2026-10-19', pv: -1 }], [{ p_date: '2026-10-19', pv: Number.MAX_SAFE_INTEGER + 1 }],
    ])('fails malformed trends rather than manufacturing valid numbers', (...rows) => {
        expect(() => normalizeCreatorStats(aggr(), rows, target, range)).toThrow();
    });
    it('does not fill missing days or relabel an article as a video', () => {
        const t = creatorTarget(`article:${id}`);
        expect(normalizeCreatorStats({ article: { id: '', url_token: id }, pv: 0 }, [], t, range)[0]).toMatchObject({ media_type: 'text', trend: [] });
    });
});
describe('Zhihu creator client', () => {
    it.each(['cumulative', 'period'])('requests explicit type and %s aggregate without type guessing', async scope => {
        const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce({ status: 200, body: aggr() }).mockResolvedValueOnce({ status: 200, body: [] }) };
        await fetchCreatorStats(page, target, { ...range, scope });
        const [aggregate, daily] = page.evaluate.mock.calls.map(([js]) => js);
        expect(aggregate).toContain('type=pin&token=' + id);
        expect(aggregate.includes('start=')).toBe(scope === 'period');
        expect(daily).toContain('start=2026-10-13');
    });
    it.each([{ status: 200, body: { error: { code: 403 } } }, { status: 403, body: {} }, { origin_error: true }, { status: 200, invalid_json: true }, { body: {} }])('rejects access and invalid responses without a second request %j', async response => {
        const page = { goto: vi.fn(), evaluate: vi.fn().mockResolvedValue(response) };
        await expect(fetchCreatorStats(page, target, range)).rejects.toThrow();
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });
    it('classifies signed-out responses and transport errors', async () => {
        await expect(fetchCreatorStats({ goto: vi.fn(), evaluate: vi.fn().mockResolvedValue({ status: 401 }) }, target, range)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
        await expect(fetchCreatorStats({ goto: vi.fn(), evaluate: vi.fn().mockRejectedValue(Error('network')) }, target, range)).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });
});
