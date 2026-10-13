import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import { Command } from 'commander';
import { registerCommandToProgram } from '../../dist/src/commanderAdapter.js';

import './overview.js';
import './trend.js';
import './sources.js';
import './posts.js';
import './post-detail.js';

const responses = vi.hoisted(() => ({ total: null, posts: null, detail: null, error: null }));

// Only browser/network retrieval is replaced. Date validation and metric mapping are real.
vi.mock('./_shared/client.js', () => ({
  fetchTotalData: async (_page, range) => {
    if (responses.error) throw responses.error;
    return responses.total ?? {
      totalData: { browse: Array(range.days).fill('1'), like: Array(range.days).fill('0') },
      dataByTabtype: [{ tabType: 4, tabTypeName: '推荐', data: { browse: Array(range.days).fill('1') } }],
    };
  },
  fetchPosts: async (_page, range, limit) => {
    if (responses.error) throw responses.error;
    return responses.posts ?? [{
      objectId: '18446744073709551615',
      createTime: 1791734400,
      desc: { description: `${range.startDate}..${range.endDate};limit=${limit}` },
      readCount: '12', likeCount: '3', favCount: '2', commentCount: 0,
      forwardAggregationCount: '5', followCount: '1',
      fullPlayRate: 0.625, avgPlayTimeSec: 2.75,
    }];
  },
  fetchPostDetail: async (_page, id, range) => {
    if (responses.error) throw responses.error;
    return responses.detail ?? {
      data: {
        feedData: [{
          totalData: { browse: Array(range.days).fill('1'), comment: Array(range.days).fill('0') },
          dataByTabtype: [{ tabType: 4, tabTypeName: '推荐', data: { browse: Array(range.days).fill('1') } }],
        }],
        notExistFansData: true,
      },
      retention: { items: [{ rate: 1, sec: 0 }, { rate: 0.125, sec: 21 }], maxLostRateSec: 21, videoLen: 107 },
    };
  },
}));

function command(name) {
  const registered = getRegistry().get(`weixin-channels/${name}`);
  expect(registered, `weixin-channels/${name} is available`).toBeDefined();
  return registered;
}

function parser(name) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  const site = program.command('weixin-channels');
  registerCommandToProgram(site, command(name));
  const subcommand = site.commands.find(item => item.name() === name);
  // Exercise the actual option parser without dispatching a browser query.
  subcommand.action(() => {});
  return { program, subcommand };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
  responses.total = null;
  responses.posts = null;
  responses.detail = null;
  responses.error = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('weixin-channels command contract', () => {
  it.each(['overview', 'trend', 'sources', 'posts', 'post-detail'])('exposes %s as a read-only browser query', name => {
    expect(command(name)).toMatchObject({
      site: 'weixin-channels', domain: 'channels.weixin.qq.com',
      access: 'read', strategy: 'cookie', browser: true, navigateBefore: false,
    });
    expect(command(name).args.find(arg => arg.name === 'days')).toMatchObject({ type: 'int' });
    expect(command(name).args.find(arg => arg.name === 'days')).not.toHaveProperty('default');
    expect(command(name).args.find(arg => arg.name === 'start-date')).toMatchObject({ type: 'str' });
    expect(command(name).args.find(arg => arg.name === 'end-date')).toMatchObject({ type: 'str' });
  });

  it('keeps table metrics discoverable and the object ID a string argument', () => {
    expect(command('overview').columns).toEqual([
      'start_date', 'end_date', 'views', 'recommendations', 'likes', 'comments', 'shares', 'follows',
    ]);
    expect(command('trend').columns).toEqual([
      'date', 'views', 'recommendations', 'likes', 'comments', 'shares', 'follows',
    ]);
    expect(command('sources').columns).toEqual([
      'source', 'views', 'views_pct', 'recommendations', 'likes', 'comments', 'shares', 'follows',
    ]);
    expect(command('posts').columns).toEqual([
      'id', 'title', 'published_at', 'views', 'recommendations', 'likes', 'comments',
      'shares', 'follows', 'completion_rate', 'avg_play_seconds',
    ]);
    expect(command('post-detail').columns).toEqual([
      'id', 'start_date', 'end_date', 'overview', 'trend', 'sources', 'data_details', 'retention',
    ]);
    expect(command('post-detail').args.find(arg => arg.name === 'id')).toMatchObject({
      required: true, positional: true, type: 'str',
    });
  });
});

describe('weixin-channels query results', () => {
  it('defaults overview to yesterday and preserves unavailable metrics', async () => {
    expect(await command('overview').func({}, {})).toEqual([{
      start_date: '2026-10-12', end_date: '2026-10-12',
      views: 1, recommendations: 0, likes: null, comments: null, shares: null, follows: null,
    }]);
  });

  it('defaults trend to seven days ending yesterday', async () => {
    const rows = await command('trend').func({}, {});
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ date: '2026-10-06', views: 1, recommendations: 0, likes: null });
    expect(rows[6]).toMatchObject({ date: '2026-10-12', views: 1 });
  });

  it('defaults sources to the same seven-day window and uses response labels', async () => {
    const rows = await command('sources').func({}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      start_date: '2026-10-06', end_date: '2026-10-12', source: '推荐', views: 7, views_pct: 100, likes: null,
    });
  });

  it('supports paired inclusive dates without an injected days conflict', async () => {
    const rows = await command('overview').func({}, { 'start-date': '2026-10-01', 'end-date': '2026-10-03' });
    expect(rows[0]).toMatchObject({ start_date: '2026-10-01', end_date: '2026-10-03', views: 3 });
  });

  it('maps account metrics through the real model', async () => {
    responses.total = {
      totalData: {
        browse: ['12', '20'], like: ['3', '0'], fav: ['1', '2'],
        comment: ['0', '4'], forwardAggregation: ['5', '1'], follow: ['2', '0'],
      },
    };
    expect(await command('overview').func({}, { days: 2 })).toEqual([{
      start_date: '2026-10-11', end_date: '2026-10-12',
      views: 32, recommendations: 3, likes: 3, comments: 4, shares: 6, follows: 2,
    }]);
  });

  it('defaults posts to thirty publication days and a limit of twenty', async () => {
    const rows = await command('posts').func({}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '18446744073709551615', title: '2026-09-13..2026-10-12;limit=20',
      views: 12, recommendations: 3, likes: 2, comments: 0, shares: 5, follows: 1,
      completion_rate: 62.5, avg_play_seconds: 2.75,
    });
  });

  it('passes an explicit posts window and limit to the retrieval boundary', async () => {
    const rows = await command('posts').func({}, {
      'start-date': '2026-10-01', 'end-date': '2026-10-03', limit: 5,
    });
    expect(rows[0].title).toBe('2026-10-01..2026-10-03;limit=5');
  });

  it('returns an empty posts collection for a valid window with no published posts', async () => {
    responses.posts = [];
    expect(await command('posts').func({}, { days: 1 })).toEqual([]);
  });

  it('keeps detail sections together and preserves a large object ID', async () => {
    const rows = await command('post-detail').func({}, { id: '18446744073709551615', days: 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '18446744073709551615', start_date: '2026-10-11', end_date: '2026-10-12',
      overview: { views: 2, comments: 0, likes: null },
      trend: [{ date: '2026-10-11', views: 1 }, { date: '2026-10-12', views: 1 }],
      sources: [{ source: '推荐', views: 2, views_pct: 100 }],
      data_details: [
        { date: '2026-10-11', source_id: 4, source: '推荐', views: 1, recommendations: null, likes: null, comments: null, shares: null, follows: null },
        { date: '2026-10-12', source_id: 4, source: '推荐', views: 1, recommendations: null, likes: null, comments: null, shares: null, follows: null },
      ],
      retention: {
        video_seconds: 107, max_loss_second: 21,
        points: [{ second: 0, retained_pct: 100 }, { second: 21, retained_pct: 12.5 }],
      },
    });
  });

  it('defaults detail to seven days ending yesterday', async () => {
    const rows = await command('post-detail').func({}, { id: '123' });
    expect(rows[0]).toMatchObject({ id: '123', start_date: '2026-10-06', end_date: '2026-10-12' });
    expect(rows[0].trend).toHaveLength(7);
  });
});

describe('weixin-channels validation', () => {
  it.each(['overview', 'trend', 'sources', 'posts', 'post-detail'])('%s rejects conflicting dates before retrieval', async name => {
    responses.error = new Error('network must not run for invalid arguments');
    await expect(command(name).func({}, {
      id: '123', days: 7, 'start-date': '2026-10-01', 'end-date': '2026-10-03',
    })).rejects.toBeInstanceOf(ArgumentError);
  });

  it.each([
    { days: 0 }, { days: -1 }, { days: 1.5 },
    { 'start-date': '2026-10-01' },
    { 'start-date': '2026-02-30', 'end-date': '2026-03-01' },
    { 'start-date': '2026-10-13', 'end-date': '2026-10-13' },
  ])('rejects an invalid date range %j', async args => {
    responses.error = new Error('network must not run for invalid arguments');
    await expect(command('overview').func({}, args)).rejects.toBeInstanceOf(ArgumentError);
  });

  it.each([0, -1, 1.5, Number.NaN, '2', 1001])('rejects an invalid posts limit %s', async limit => {
    responses.error = new Error('network must not run for invalid arguments');
    await expect(command('posts').func({}, { limit })).rejects.toBeInstanceOf(ArgumentError);
  });

  it.each([undefined, '', ' ', 'abc', '1.5', '-1', 123, 18446744073709551615n])('rejects an invalid detail object ID %s', async id => {
    responses.error = new Error('network must not run for invalid arguments');
    await expect(command('post-detail').func({}, { id })).rejects.toBeInstanceOf(ArgumentError);
  });

  it('preserves retrieval errors instead of fabricating zero metrics', async () => {
    responses.error = new Error('server refused the query');
    await expect(command('overview').func({}, {})).rejects.toThrow('server refused the query');
  });
});

describe('weixin-channels Commander parsing', () => {
  const missingValueCases = ['overview', 'trend', 'sources', 'posts', 'post-detail'].flatMap(name => (
    ['days', 'start-date', 'end-date'].map(option => [name, option])
  ));

  it.each([...missingValueCases, ['posts', 'limit']])('%s rejects bare --%s instead of treating it as a value', async (name, option) => {
    const { program } = parser(name);
    let error;
    try {
      await program.parseAsync([
        'weixin-channels', name, ...(name === 'post-detail' ? ['18446744073709551615'] : []), `--${option}`,
      ], { from: 'user' });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('commander.optionMissingArgument');
  });

  it('parses explicit dates without inserting the default days option', async () => {
    const { program, subcommand } = parser('posts');
    await program.parseAsync([
      'weixin-channels', 'posts', '--start-date', '2026-10-01', '--end-date', '2026-10-03', '--limit', '5',
    ], { from: 'user' });
    expect(subcommand.opts()).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-03', limit: '5' });
    expect(subcommand.opts()).not.toHaveProperty('days');
  });

  it('preserves a large positional object ID through the actual parser', async () => {
    const { program, subcommand } = parser('post-detail');
    await program.parseAsync([
      'weixin-channels', 'post-detail', '18446744073709551615', '--days', '2',
    ], { from: 'user' });
    expect(subcommand.args[0]).toBe('18446744073709551615');
    expect(subcommand.opts().days).toBe('2');
  });
});
