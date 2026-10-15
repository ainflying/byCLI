import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserFetch: vi.fn(),
  getUploadAuthV5Credentials: vi.fn(),
  applyVideoUploadInner: vi.fn(),
  commitVideoUploadInner: vi.fn(),
  tosUpload: vi.fn(),
  pollTranscode: vi.fn(),
  imagexUpload: vi.fn(),
}));

vi.mock('./_shared/browser-fetch.js', () => ({ browserFetch: mocks.browserFetch }));
vi.mock('./_shared/vod-upload.js', () => ({
  getUploadAuthV5Credentials: mocks.getUploadAuthV5Credentials,
  applyVideoUploadInner: mocks.applyVideoUploadInner,
  commitVideoUploadInner: mocks.commitVideoUploadInner,
}));
vi.mock('./_shared/tos-upload.js', () => ({ tosUpload: mocks.tosUpload }));
vi.mock('./_shared/transcode.js', () => ({ pollTranscode: mocks.pollTranscode }));
vi.mock('./_shared/imagex-upload.js', () => ({ imagexUpload: mocks.imagexUpload }));

describe('douyin publish upload identifier handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getUploadAuthV5Credentials.mockResolvedValue({ access_key_id: 'ak', secret_access_key: 'sk', session_token: 'token' });
    mocks.applyVideoUploadInner.mockResolvedValue({ video_id: 'apply-video-id', tos_upload_url: 'https://tos.example.com/bucket/key', auth: 'auth', session_key: 'session-key' });
    mocks.commitVideoUploadInner.mockResolvedValue({ video_id: 'canonical-video-id', poster_uri: 'poster-uri' });
    mocks.tosUpload.mockResolvedValue('object-key-returned-by-complete');
    mocks.pollTranscode.mockResolvedValue({ width: 720, height: 1280, poster_uri: 'poster-uri' });
    mocks.browserFetch.mockImplementation(async (_page, method, url) => {
      if (method === 'POST' && String(url).includes('/aweme/create_v2/')) return { aweme_id: 'aweme-1' };
      return { status_code: 0 };
    });
  });


  async function runPublish(overrides = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-publish-mode-'));
    try {
      const video = path.join(tmpDir, 'video.mp4');
      fs.writeFileSync(video, 'test-video');
      const { getRegistry } = await import('@sovovs/bycli/registry');
      await import('./publish.js');
      return await getRegistry().get('douyin/publish').func({}, {
        video, title: 'test', caption: '', visibility: 'private', no_safety_check: true, ...overrides,
      });
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }

  it('requires exactly one explicit immediate or scheduled mode before upload', async () => {
    await expect(runPublish()).rejects.toThrow(/--now.*--schedule/);
    await expect(runPublish({ now: true, schedule: new Date(Date.now() + 10800000).toISOString() })).rejects.toThrow(/--now.*--schedule/);
    expect(mocks.getUploadAuthV5Credentials).not.toHaveBeenCalled();
  });

  it('publishes immediate mode with timing zero and reports submission without claiming approval', async () => {
    const rows = await runPublish({ now: true });
    const request = mocks.browserFetch.mock.calls.find(call => String(call[2]).includes('/aweme/create_v2/'));
    expect(request[3].body.item.common.timing).toBe(0);
    expect(rows[0]).toMatchObject({ status: '已提交发布，等待平台处理', aweme_id: 'aweme-1', publish_time: null });
  });

  it('retains scheduled limits and renders scheduled time as ISO with client timezone context', async () => {
    await expect(runPublish({ schedule: new Date(Date.now() + 3600000).toISOString() })).rejects.toThrow('2 小时');
    await expect(runPublish({ schedule: new Date(Date.now() + 15 * 86400000).toISOString() })).rejects.toThrow('14 天');
    const schedule = Math.floor((Date.now() + 10800000) / 1000);
    const rows = await runPublish({ schedule: String(schedule) });
    expect(rows[0].publish_time).toBe(new Date(schedule * 1000).toISOString());
    expect(rows[0].timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(rows[0].status).toBe('已提交定时发布，等待平台处理');
  });

  it('does not treat a response without an identifier as successful', async () => {
    mocks.browserFetch.mockResolvedValue({ status_code: 0 });
    await expect(runPublish({ now: true })).rejects.toThrow(/无法确认发布结果/);
  });

  it('uses CommitUploadInner Vid for create_v2, not the completed TOS object key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-publish-id-'));
    const video = path.join(tmpDir, 'video.mp4');
    fs.writeFileSync(video, Buffer.from('fake-video'));

    const { getRegistry } = await import('@sovovs/bycli/registry');
    getRegistry().delete('douyin/publish');
    await import('./publish.js');
    const cmd = getRegistry().get('douyin/publish');
    if (!cmd) throw new Error('douyin publish command not registered');

    await cmd.func({}, {
      video,
      title: 'byCLI自测',
      schedule: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      caption: '',
      visibility: 'private',
      no_safety_check: true,
    });

    expect(mocks.commitVideoUploadInner).toHaveBeenCalledWith(
      { video_id: 'apply-video-id', tos_upload_url: 'https://tos.example.com/bucket/key', auth: 'auth', session_key: 'session-key' },
      { access_key_id: 'ak', secret_access_key: 'sk', session_token: 'token' },
    );
    expect(mocks.pollTranscode).not.toHaveBeenCalled();
    const createCall = mocks.browserFetch.mock.calls.find((call) => String(call[2]).includes('/aweme/create_v2/'));
    expect(createCall?.[3]?.body.item.common.video_id).toBe('canonical-video-id');
    expect(createCall?.[3]?.body.item.common.video_id).not.toBe('object-key-returned-by-complete');
  });

  it('continues to create_v2 when the legacy fast detect API returns an empty response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-publish-safety-'));
    const video = path.join(tmpDir, 'video.mp4');
    fs.writeFileSync(video, Buffer.from('fake-video'));
    mocks.browserFetch.mockImplementation(async (_page, method, url) => {
      if (method === 'POST' && String(url).includes('/post_assistant/fast_detect/pre_check')) {
        throw new Error('Empty response from Douyin API (POST https://creator.douyin.com/aweme/v1/post_assistant/fast_detect/pre_check)');
      }
      if (method === 'POST' && String(url).includes('/post_assistant/fast_detect/poll')) return { status: -1, has_done: true, detect_result: { reason_code: 0 }, detect_list: [] };
      if (method === 'POST' && String(url).includes('/aweme/create_v2/')) return { item_id: 'item-1' };
      return { status_code: 0 };
    });

    const { getRegistry } = await import('@sovovs/bycli/registry');
    getRegistry().delete('douyin/publish');
    await import('./publish.js');
    const cmd = getRegistry().get('douyin/publish');
    if (!cmd) throw new Error('douyin publish command not registered');

    await cmd.func({}, {
      video,
      title: 'byCLI自测',
      schedule: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      visibility: 'public',
      caption: 'caption',
      no_safety_check: false,
    });

    expect(mocks.browserFetch.mock.calls.some((call) => String(call[2]).includes('/post_assistant/fast_detect/pre_check'))).toBe(true);
    expect(mocks.browserFetch.mock.calls.some((call) => String(call[2]).includes('/aweme/create_v2/'))).toBe(true);
  });

  it('unwraps Browser Bridge envelopes around cover ImageX evaluate results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-publish-cover-'));
    const video = path.join(tmpDir, 'video.mp4');
    const cover = path.join(tmpDir, 'cover.jpg');
    fs.writeFileSync(video, Buffer.from('fake-video'));
    fs.writeFileSync(cover, Buffer.from('fake-cover'));
    mocks.imagexUpload.mockResolvedValue('cover-store-uri');

    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          session: 'site:douyin:test',
          data: { Result: { UploadAddress: { StoreInfos: [{ UploadHost: 'imagex.example.com', StoreUri: 'cover/key.jpg' }] } } },
        })
        .mockResolvedValueOnce({ session: 'site:douyin:test', data: { Result: {} } }),
    };

    const { getRegistry } = await import('@sovovs/bycli/registry');
    getRegistry().delete('douyin/publish');
    await import('./publish.js');
    const cmd = getRegistry().get('douyin/publish');
    if (!cmd) throw new Error('douyin publish command not registered');

    await cmd.func(page, {
      video,
      cover,
      title: 'byCLI自测',
      schedule: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      caption: '',
      visibility: 'private',
      no_safety_check: true,
    });

    expect(mocks.imagexUpload).toHaveBeenCalledWith(cover, {
      upload_url: 'https://imagex.example.com/cover/key.jpg',
      store_uri: 'cover/key.jpg',
    });
    const createCall = mocks.browserFetch.mock.calls.find((call) => String(call[2]).includes('/aweme/create_v2/'));
    expect(createCall?.[3]?.body.item.cover.poster).toBe('cover-store-uri');
  });

  it('throws typed when cover ImageX apply returns the wrong shape', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-publish-cover-bad-'));
    const video = path.join(tmpDir, 'video.mp4');
    const cover = path.join(tmpDir, 'cover.jpg');
    fs.writeFileSync(video, Buffer.from('fake-video'));
    fs.writeFileSync(cover, Buffer.from('fake-cover'));

    const page = { evaluate: vi.fn().mockResolvedValueOnce({ session: 'site:douyin:test', data: { Result: { UploadAddress: { StoreInfos: [] } } } }) };

    const { getRegistry } = await import('@sovovs/bycli/registry');
    getRegistry().delete('douyin/publish');
    await import('./publish.js');
    const cmd = getRegistry().get('douyin/publish');
    if (!cmd) throw new Error('douyin publish command not registered');

    await expect(cmd.func(page, {
      video,
      cover,
      title: 'byCLI自测',
      schedule: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      caption: '',
      visibility: 'private',
      no_safety_check: true,
    })).rejects.toThrow('UploadHost/StoreUri');
    expect(mocks.imagexUpload).not.toHaveBeenCalled();
  });
});
