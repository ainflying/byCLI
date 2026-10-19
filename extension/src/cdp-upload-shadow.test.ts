import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('dedicated file upload in open shadow roots', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  async function setup(matches: Record<number, number[] | undefined>, type = 'file') {
    const send = vi.fn(async (_target: unknown, method: string, params: any = {}) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, children: [{ nodeId: 2, shadowRoots: [
        { nodeId: 3, shadowRootType: 'open', children: [{ nodeId: 4, shadowRoots: [{ nodeId: 5, shadowRootType: 'open' }] }] },
        { nodeId: 6, shadowRootType: 'closed' },
      ], contentDocument: { nodeId: 7 } }] } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: matches[params.nodeId] || [] };
      if (method === 'DOM.getAttributes') return { attributes: ['type', type] };
      if (method === 'DOM.describeNode') return { node: { localName: 'input' } };
      return {};
    });
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 1, url: 'http://localhost/test', windowId: 1 })) },
      debugger: { attach: vi.fn(), sendCommand: send }, runtime: { id: 'test' },
    });
    const { setFileInputFiles } = await import('./cdp');
    return { send, upload: () => setFileInputFiles(1, ['/tmp/video.mp4'], '[data-marker="x"]') };
  }
  it('sets only the unique open-shadow input and never uses Runtime evaluation', async () => {
    const { send, upload } = await setup({ 5: [9] });
    await upload();
    expect(send).toHaveBeenCalledWith({ tabId: 1 }, 'DOM.setFileInputFiles', { files: ['/tmp/video.mp4'], nodeId: 9 });
    const queried = send.mock.calls.filter(c => c[1] === 'DOM.querySelectorAll').map(c => c[2].nodeId);
    expect(queried).toEqual([1, 3, 5]);
    expect(send.mock.calls.some(c => c[1] === 'Runtime.evaluate')).toBe(false);
  });
  it.each([{ 1: [8], 5: [9] }, {}])('rejects ambiguous/missing inputs before setting files', async matches => {
    const { send, upload } = await setup(matches);
    await expect(upload()).rejects.toThrow('exactly one');
    expect(send.mock.calls.some(c => c[1] === 'DOM.setFileInputFiles')).toBe(false);
  });
  it('rejects a matching non-file input', async () => {
    const { send, upload } = await setup({ 3: [9] }, 'text');
    await expect(upload()).rejects.toThrow('not an input');
    expect(send.mock.calls.some(c => c[1] === 'DOM.setFileInputFiles')).toBe(false);
  });
});
