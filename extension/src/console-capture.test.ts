import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only chrome.debugger is substituted: attach/enable invoke the actual registered handlers.
async function harness() {
  const events: Array<(source: any, method: string, params: any) => unknown> = [];
  const removed: Array<(tabId: number) => unknown> = [];
  const detached: Array<(source: any) => unknown> = [];
  const emit = async (source: any, method: string, params: any) => {
    for (const handler of events) await handler(source, method, params);
  };
  const sendCommand = vi.fn(async (_source: any, _method: string, _params?: any): Promise<any> => ({}));
  const chrome = {
    tabs: { get: vi.fn(async (id: number) => ({ id, url: 'http://fixture.test/' })),
      onRemoved: { addListener: (h: any) => removed.push(h) }, onUpdated: { addListener: vi.fn() } },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand,
      onEvent: { addListener: (h: any) => events.push(h) }, onDetach: { addListener: (h: any) => detached.push(h) } },
  };
  vi.stubGlobal('chrome', chrome);
  const mod = await import('./cdp');
  mod.registerListeners();
  return { mod, chrome, emit, removed, detached, sendCommand };
}

describe('Browser Bridge console capture', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('captures replayed console and exceptions during the first Runtime.enable without consuming reads', async () => {
    const h = await harness();
    h.sendCommand.mockImplementation(async (source, method) => {
      if (method === 'Runtime.enable') {
        await h.emit(source, 'Runtime.consoleAPICalled', { type: 'warning', timestamp: 1700000000000,
          args: [{ value: 'early warning' }, { type: 'object', description: 'Object', objectId: 'never-expand' }] });
        await h.emit(source, 'Runtime.exceptionThrown', { timestamp: 1700000000000,
          exceptionDetails: { exception: { description: 'Error: early failure' }, url: 'http://fixture.test/app.js', lineNumber: 3 } });
      }
      return {};
    });
    await h.mod.ensureAttached(1);
    const messages = await h.mod.consoleMessages(1);
    expect(messages).toMatchObject([
      { type: 'warning', text: 'early warning Object', timestamp: 1700000000000 },
      { type: 'error', text: 'Error: early failure', url: 'http://fixture.test/app.js', lineNumber: 3 },
    ]);
    expect(messages[0].id).not.toBe(messages[1].id);
    expect(messages[1].seq).toBeGreaterThan(messages[0].seq);
    expect(await h.mod.consoleMessages(1, 'error')).toEqual(messages);
    expect(await h.mod.consoleMessages(1, 'warning')).toEqual([messages[0]]);
    expect(await h.mod.consoleMessages(1, 'log')).toEqual([]);
    expect(h.sendCommand.mock.calls.some(([, method]) => method === 'Runtime.getProperties')).toBe(false);
  });

  it('keeps repeated messages, bounds scalars and per-tab buffers, and isolates snapshots', async () => {
    const h = await harness();
    await h.mod.ensureAttached(1); await h.mod.ensureAttached(2);
    for (let i = 0; i < 502; i++) {
      await h.emit({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', timestamp: 1700000000000, args: [{ value: 'repeat' }] });
    }
    await h.emit({ tabId: 2 }, 'Runtime.consoleAPICalled', { type: 'info', args: [
      { value: 'x'.repeat(20000) }, { value: { secret: 'must-not-serialize' }, description: 'Object' }, { unserializableValue: 'NaN' },
    ] });
    const a = await h.mod.consoleMessages(1), b = await h.mod.consoleMessages(2);
    expect(a).toHaveLength(500); expect(new Set(a.map(m => m.id)).size).toBe(500);
    expect(b).toHaveLength(1); expect(b[0].text.length).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(b)).not.toContain('must-not-serialize');
    a[0].text = 'changed by caller';
    expect((await h.mod.consoleMessages(1))[0].text).toBe('repeat');
  });

  it('arms iframe Runtime before resuming and preserves source without accepting unknown or detached child sessions', async () => {
    const h = await harness(); await h.mod.ensureAttached(1); await h.mod.ensureAttached(2);
    h.sendCommand.mockImplementation(async (source, method) => {
      if (source.sessionId === 'child' && method === 'Runtime.enable') {
        await h.emit(source, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'child error' }] });
      }
      return {};
    });
    await h.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe', url: 'http://iframe.test/?token=private' } });
    expect(await h.mod.consoleMessages(1)).toMatchObject([
      { text: 'child error', frameSessionId: 'child', frameUrl: 'http://iframe.test/?token=***' },
    ]);
    const methods = h.sendCommand.mock.calls.filter(([s]) => s.sessionId === 'child').map(([, m]) => m);
    expect(methods.indexOf('Runtime.enable')).toBeLessThan(methods.indexOf('Runtime.runIfWaitingForDebugger'));
    await h.emit({ tabId: 2, sessionId: 'child' }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'wrong-tab' }] });
    await h.emit({ tabId: 1, sessionId: 'unknown' }, 'Runtime.consoleAPICalled', { type: 'error', args: [] });
    await h.emit({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'child' });
    await h.emit({ tabId: 1, sessionId: 'child' }, 'Runtime.consoleAPICalled', { type: 'error', args: [] });
    expect(await h.mod.consoleMessages(1)).toHaveLength(1); expect(await h.mod.consoleMessages(2)).toEqual([]);
  });

  it.each(['explicit', 'debugger', 'removed'] as const)('clears capture on %s detach and gives a new capture stable IDs', async (kind) => {
    const h = await harness(); await h.mod.ensureAttached(1);
    await h.emit({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'before' }] });
    const oldId = (await h.mod.consoleMessages(1))[0].id;
    if (kind === 'explicit') await h.mod.detach(1);
    if (kind === 'debugger') for (const fn of h.detached) await fn({ tabId: 1 });
    if (kind === 'removed') for (const fn of h.removed) await fn(1);
    await h.emit({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'stale' }] });
    expect(await h.mod.consoleMessages(1)).toEqual([]);
    await h.emit({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'after' }] });
    const now = await h.mod.consoleMessages(1);
    expect(now).toHaveLength(1); expect(now[0].id).not.toBe(oldId);
  });

  it('does not revive console child state when detach interrupts arming', async () => {
    const h = await harness(); await h.mod.ensureAttached(1);
    h.sendCommand.mockImplementation(async (source, method) => {
      if (source.sessionId === 'racing' && method === 'Target.setAutoAttach') await h.mod.detach(1);
      return {};
    });
    await h.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'racing', targetInfo: { type: 'iframe', url: 'http://iframe.test/' } });
    expect(h.sendCommand.mock.calls.some(([s, m]) => s.sessionId === 'racing' && m === 'Runtime.enable')).toBe(false);
    expect(await h.mod.consoleMessages(1)).toEqual([]);
  });

  it('surfaces a Runtime enable failure instead of claiming an empty console', async () => {
    const h = await harness();
    h.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Runtime.enable') throw new Error('Debugger disconnected');
      return {};
    });
    await expect(h.mod.consoleMessages(1)).rejects.toThrow(/console.*Runtime.*disconnected/i);
  });

  it('uses the iframe document URL after an initially blank OOPIF attaches', async () => {
    const h = await harness(); await h.mod.ensureAttached(1);
    h.sendCommand.mockImplementation(async (source, method) => {
      if (source.sessionId === 'loading-child' && method === 'Runtime.runIfWaitingForDebugger') {
        await h.emit(source, 'Page.frameNavigated', { frame: { id: 'iframe-target', url: 'http://child.test/document?token=private' } });
        await h.emit(source, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'loaded' }],
          stackTrace: { callFrames: [{ url: 'http://cdn.test/script.js' }] } });
      }
      return {};
    });
    await h.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'loading-child', targetInfo: { targetId: 'iframe-target', type: 'iframe', url: '' } });
    expect(await h.mod.consoleMessages(1)).toMatchObject([{ text: 'loaded', frameUrl: 'http://child.test/document?token=***', url: 'http://cdn.test/script.js' }]);
  });

  it('keeps console-only child startup paused after executing in an existing frame target', async () => {
    const h = await harness(); await h.mod.ensureAttached(1);
    h.sendCommand.mockImplementation(async (_source, method) => method === 'Target.getTargets'
      ? { targetInfos: [{ targetId: 'existing-frame', type: 'iframe', url: 'http://child.test/' }] } : {});
    await h.mod.sendCommandInFrameTarget(1, 'existing-frame', 'Runtime.evaluate', { expression: '1' });
    const autoAttach = h.sendCommand.mock.calls.filter(([source, method]) => source.tabId === 1 && !source.sessionId && method === 'Target.setAutoAttach');
    expect(autoAttach.at(-1)?.[2]).toMatchObject({ waitForDebuggerOnStart: true });
    await h.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'next-child', targetInfo: { targetId: 'next-frame', type: 'iframe', url: 'http://next.test/' } });
    const methods = h.sendCommand.mock.calls.filter(([source]) => source.sessionId === 'next-child').map(([, method]) => method);
    expect(methods.indexOf('Runtime.enable')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Runtime.enable')).toBeLessThan(methods.indexOf('Runtime.runIfWaitingForDebugger'));
  });

  it('updates a nested target URL by target identity without overwriting its parent or another tab', async () => {
    const h = await harness(); await h.mod.ensureAttached(1); await h.mod.ensureAttached(2);
    await h.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'outer', targetInfo: { targetId: 'T1', type: 'iframe', url: 'http://outer.test/' } });
    await h.emit({ tabId: 1, sessionId: 'outer' }, 'Target.attachedToTarget', { sessionId: 'inner', targetInfo: { targetId: 'T2', type: 'iframe', url: 'http://inner.test/' } });
    await h.emit({ tabId: 1, sessionId: 'outer' }, 'Target.targetInfoChanged', { targetInfo: { targetId: 'T2', type: 'iframe', url: 'http://inner.test/landed' } });
    await h.emit({ tabId: 2 }, 'Target.targetInfoChanged', { targetInfo: { targetId: 'T1', type: 'iframe', url: 'http://wrong-tab.test/' } });
    for (const sessionId of ['outer', 'inner']) {
      await h.emit({ tabId: 1, sessionId }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: sessionId }] });
    }
    expect(await h.mod.consoleMessages(1)).toMatchObject([
      { text: 'outer', frameUrl: 'http://outer.test/' }, { text: 'inner', frameUrl: 'http://inner.test/landed' },
    ]);
  });
});
