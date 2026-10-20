import { beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ raw: null, calls: [] }));
vi.mock('./_shared/client.js', () => ({ fetchPostMetrics: async (_page, id) => { backend.calls.push(['statistics', id]); return backend.raw; } }));
vi.mock('./_shared/management.js', () => ({ fetchManagementPost: async (_page, id) => { backend.calls.push(['management', id]); return backend.raw; } }));
import { videoStatsCommand, videoMetrics, videoStatsTarget, VIDEO_STATS_COLUMNS } from './video-stats.js';
const id = '15035867620425145936';
beforeEach(() => { backend.calls = []; backend.raw = { objectId: id, createTime: 1792415096, desc: { description: '合成测试样本' }, readCount: 12, likeCount: 5, favCount: 6, commentCount: 2, forwardAggregationCount: 3 }; });
// Synthetic minimal metric contract, not real platform evidence.
describe('video cumulative collection', () => {
  it('retains the exact ID, separates recommendation/like and never misreports like as collection', () => {
    const row = videoMetrics(backend.raw, videoStatsTarget(id), 'sample');
    expect(row).toMatchObject({ id, plays: 12, recommendations: 5, likes: 6, comments: 2, shares: 3,
      collections: null, unavailable_metrics: { collections: 'not_exposed_by_verified_backend' }, sampled_at: 'sample' });
    expect(Object.keys(row)).toEqual(VIDEO_STATS_COLUMNS);
  });
  it('preserves true zero and marks missing counts separately', () => {
    backend.raw.readCount = 0; delete backend.raw.commentCount;
    expect(videoMetrics(backend.raw, videoStatsTarget(id))).toMatchObject({ plays: 0, comments: null, unavailable_metrics: { comments: 'not_returned' } });
  });
  it.each(['', 'export/', 'https://example.com/123', 123, '12e3'])('rejects an ambiguous target %s', target => expect(() => videoStatsTarget(target)).toThrow());
  it('rejects mismatched identity and malformed metrics', () => {
    expect(() => videoMetrics(backend.raw, videoStatsTarget('1'))).toThrow('exact ID');
    backend.raw.readCount = -1; expect(() => videoMetrics(backend.raw, videoStatsTarget(id))).toThrow();
  });
  it('uses numeric identity lookup without a publishing operation journal', async () => {
    expect((await videoStatsCommand.func({}, { id }))[0].id_type).toBe('statistics');
    expect(backend.calls).toEqual([['statistics', id]]);
  });
  it('uses the verified management reader for export IDs and refuses unpublished drafts', async () => {
    backend.raw.objectId = 'export/example'; backend.raw.status = 1;
    expect((await videoStatsCommand.func({}, { id: 'export/example' }))[0].id_type).toBe('management');
    expect(backend.calls).toEqual([['management', 'export/example']]);
    backend.raw.status = 0; await expect(videoStatsCommand.func({}, { id: 'export/example' })).rejects.toThrow('not published');
  });
});
