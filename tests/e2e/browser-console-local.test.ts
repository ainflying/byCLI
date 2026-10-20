/**
 * Real daemon + built Browser Bridge + disposable Chrome + loopback fixtures.
 * npm run build && npm run build:extension
 * BYCLI_CONSOLE_E2E=1 npx vitest run --project e2e tests/e2e/browser-console-local.test.ts
 * No existing daemon/browser/profile is discovered, contacted, or stopped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const headers = { 'X-byCLI': '1', 'Content-Type': 'application/json' };
const chromePath = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(file => fs.existsSync(file));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as { port: number }).port;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { const result = await read(); if (result !== undefined) return result; } catch (err) { lastError = err; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${String(lastError)})` : ''}`);
}

async function loadUnpacked(browserSocket: string, extensionPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(browserSocket);
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('Timed out loading the isolated unpacked extension')), 10_000);
    socket.once('error', finish);
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extensionPath } })));
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id === 1) finish(message.error ? new Error(JSON.stringify(message.error)) : undefined);
    });
  });
}

describe('console on an isolated local browser', () => {
  let directory = '', daemonPort = 0, fixturePort = 0, count = 0;
  let fixture: Server | undefined, daemon: ChildProcess | undefined, chrome: ChildProcess | undefined;
  let env: NodeJS.ProcessEnv;
  let diagnostic = '';
  let pageA: string, pageB: string;

  async function command(action: string, params: Record<string, unknown> = {}): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/command`, {
      method: 'POST', headers, body: JSON.stringify({ id: `local-console-${++count}`, action, session: 'console-a', surface: 'browser', windowMode: 'background', ...params }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
  }

  function cli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'dist/src/main.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local console CLI timed out')); }, 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`CLI ${code}: ${stderr}\n${stdout}`)); });
    });
  }

  beforeAll(async () => {
    if (!chromePath) throw new Error('Chrome missing: install a local browser or pass CHROME_PATH; this opt-in e2e cannot run.');
    if (!fs.existsSync(path.join(root, 'dist/src/main.js'))) throw new Error('Run npm run build before this opt-in e2e.');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-console-e2e-'));
    const temporary = path.join(directory, 'tmp'); fs.mkdirSync(temporary);
    // Reserve an ephemeral port, then let only this test's daemon bind it. A collision fails safely.
    const reservation = createServer(); daemonPort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    env = { ...process.env, BYCLI_DAEMON_PORT: String(daemonPort), BYCLI_CONFIG_DIR: path.join(directory, 'config'),
      TMPDIR: temporary, BYCLI_CDP_ENDPOINT: '', BYCLI_CDP_APP: '', BYCLI_PROFILE: '', BYCLI_CONTEXT_ID: '' };
    daemon = spawn(process.execPath, [path.join(root, 'dist/src/daemon.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-10000); });
    daemon.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-10000); });
    await waitFor(async () => {
      if (daemon?.exitCode !== null) throw new Error(diagnostic);
      return (await fetch(`http://127.0.0.1:${daemonPort}/ping`, { signal: AbortSignal.timeout(500) })).ok ? true : undefined;
    }, 'isolated daemon startup');
    const extension = path.join(directory, 'extension'); fs.mkdirSync(extension);
    for (const file of ['manifest.json', 'popup.html', 'popup.js', 'icons', 'dist']) {
      fs.cpSync(path.join(root, 'extension', file), path.join(extension, file), { recursive: true });
    }
    const bundlePath = path.join(extension, 'dist/background.js'), bundle = fs.readFileSync(bundlePath, 'utf8');
    const patched = bundle.replace('const DAEMON_PORT = 19825;', `const DAEMON_PORT = ${daemonPort};`);
    if (patched === bundle) throw new Error('Temporary extension port patch did not match; rebuild/update the fixture harness.');
    fs.writeFileSync(bundlePath, patched);
    fixture = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/child') {
        res.end('<script>console.error("iframe early failure");</script>child'); return;
      }
      if (req.url === '/late-child') {
        res.end('<script>console.error("later OOPIF startup");console.clear();</script>late child'); return;
      }
      if (req.url === '/b') { res.end('<script>console.info("tab B only");</script>tab B'); return; }
      if (req.url === '/screenshot') {
        res.end(`<!doctype html><meta charset="utf-8"><title>Local fixture visual test</title><style>
          body{font:20px/1.6 sans-serif;color:#172b4d;background:#f5f7fa;margin:0;padding:48px}
          main{max-width:850px;padding:36px;background:white;border:2px solid #c5d1df;border-radius:12px}
          small{font-weight:bold;color:#445d7a}h1{font-size:34px;line-height:1.2}h2{font-size:26px}
        </style><main><small>LOCAL FIXTURE VISUAL TEST · SCREEN 1</small>
          <h1>Console capture local fixture</h1><h2>Read-only screenshot</h2>
          <p>Existing test page captured through a real byCLI owned tab.</p>
          <p>This image verifies CLI and screenshot-helper interoperability.</p>
          <p>Fixture only. No production materials or platform attachments.</p>
        </main>`); return;
      }
      res.end(`<script>
        window.originalLog = console.log;
        window.consoleGetterCalls = 0;
        console.log({ get secret() { window.consoleGetterCalls++; return 'must-not-expand'; } });
        console.warn('early warning'); console.error('early error token=fixture-secret');
        setTimeout(() => { throw new Error('early uncaught exception'); }, 0);
      </script><iframe src="http://bycli-frame.test:${fixturePort}/child"></iframe>`);
    });
    fixturePort = await listen(fixture);
    chrome = spawn(chromePath, [
      `--user-data-dir=${path.join(directory, 'chrome-profile')}`, '--remote-debugging-port=0',
      '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-unsafe-extension-debugging', '--headless=new',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update',
      '--no-proxy-server', '--site-per-process', '--host-resolver-rules=MAP bycli-top.test 127.0.0.1, MAP bycli-frame.test 127.0.0.1', 'about:blank',
    ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-10000); });
    try {
      const activePort = await waitFor(async () => {
        const file = path.join(directory, 'chrome-profile/DevToolsActivePort');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : undefined;
      }, 'private Chrome debugging port');
      await loadUnpacked(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`, extension);
      await waitFor(async () => {
        const status = await (await fetch(`http://127.0.0.1:${daemonPort}/status`, { headers })).json() as any;
        return status.extensionConnected ? status : undefined;
      }, 'isolated extension hello');
    } catch (error) { throw new Error(`${String(error)}\n${diagnostic}`); }
    pageA = (await command('navigate', { url: `http://bycli-top.test:${fixturePort}/a` })).page;
    pageB = (await command('navigate', { session: 'console-b', url: `http://bycli-top.test:${fixturePort}/b` })).page;
  }, 60_000);

  afterAll(async () => {
    await stop(chrome); await stop(daemon);
    if (fixture) await new Promise<void>(resolve => fixture!.close(() => resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reads early warnings, uncaught exceptions and OOPIF errors through the real CLI with redaction and tab isolation', async () => {
    const raw = await waitFor(async () => {
      const messages = (await command('console-messages', { page: pageA })).data as any[];
      return messages.some(message => message.text.includes('iframe early failure')) ? messages : undefined;
    }, 'iframe console capture');
    expect(raw).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'warning', text: 'early warning' }),
      expect.objectContaining({ type: 'error', text: expect.stringContaining('early uncaught exception') }),
      expect.objectContaining({ type: 'error', text: 'iframe early failure', frameSessionId: expect.any(String), frameUrl: expect.stringContaining('bycli-frame.test') }),
    ]));
    expect(raw.some(message => message.text === 'tab B only')).toBe(false);
    const output = await cli(['browser', 'console-a', 'console', '--tab', pageA, '--level', 'error', '--since', '2m']);
    const json = JSON.parse(output);
    expect(json.count).toBeGreaterThanOrEqual(4); expect(output).not.toContain('fixture-secret'); expect(output).toContain('[REDACTED]');
    expect((await command('console-messages', { session: 'console-b', page: pageB })).data).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'tab B only' })]));
    expect((await command('console-messages', { session: 'console-b', page: pageB })).data.some((message: any) => message.text.includes('early warning'))).toBe(false);
    const original = await command('exec', { page: pageA, code: 'console.log === window.originalLog' });
    expect(original.data).toBe(true);
    expect((await command('exec', { page: pageA, code: 'window.consoleGetterCalls' })).data).toBe(0);
    expect(JSON.stringify(raw)).not.toContain('must-not-expand');
    await command('exec', { page: pageA, code: `(() => { const frame = document.createElement('iframe'); frame.src = 'http://bycli-frame.test:${fixturePort}/late-child'; document.body.appendChild(frame); return true; })()` });
    const laterStartup = await waitFor(async () => {
      const messages = (await command('console-messages', { page: pageA })).data as any[];
      return messages.find(message => message.text === 'later OOPIF startup');
    }, 'new OOPIF startup followed immediately by console.clear');
    expect(laterStartup).toMatchObject({ type: 'error', frameSessionId: expect.any(String), frameUrl: expect.stringContaining('/late-child') });
  }, 30_000);

  it('keeps stable IDs for identical repeats, caps at 500 and clears the old capture after session release', async () => {
    await command('exec', { page: pageA, code: 'for (let i=0;i<505;i++) console.log("repeat fixture"); true' });
    const first = (await command('console-messages', { page: pageA })).data;
    const second = (await command('console-messages', { page: pageA })).data;
    expect(first).toHaveLength(500); expect(second).toEqual(first); expect(new Set(first.map((message: any) => message.id)).size).toBe(500);
    expect(first.every((message: any) => message.text === 'repeat fixture')).toBe(true);
    const oldIds = new Set(first.map((message: any) => message.id));
    await command('close-window');
    const fresh = (await command('console-messages')).data;
    expect(fresh.some((message: any) => oldIds.has(message.id))).toBe(false);
    expect(fresh).toEqual([]);
  }, 30_000);

  it.runIf(Boolean(process.env.BYCLI_SCREENSHOT_HELPER))('interoperates with a black-box screenshot helper using a fixture-only PNG and ZIP', async () => {
    const helper = process.env.BYCLI_SCREENSHOT_HELPER!;
    if (!path.isAbsolute(helper)) throw new Error('BYCLI_SCREENSHOT_HELPER must be an absolute executable module path.');
    const evidenceRoot = process.env.BYCLI_SCREENSHOT_EVIDENCE_DIR ?? path.join(directory, 'screenshot-fixture');
    fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    // macOS /tmp and /var are aliases; the helper correctly refuses symlinked collection ancestry.
    const run = path.join(fs.realpathSync(evidenceRoot), `fixture-only-${randomUUID()}`);
    const sessionsRoot = path.join(run, 'sessions'), sessionRoot = path.join(sessionsRoot, 'local-fixture');
    fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const sessionDir = 'collections/visual-fixture';
    const helperEnv = { ...env, KNOWLEDGE_COLLECTION_SESSIONS_ROOT: sessionsRoot };
    const invoke = (action: string, args: string[] = []): Promise<any> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, action, '--session-root', sessionRoot, '--session-dir', sessionDir, ...args],
        { env: helperEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Fixture helper ${action} timed out`)); }, 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(stdout);
          if (code !== 0 || result.ok !== true) throw new Error(`Fixture helper ${action}: ${stdout}\n${stderr}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    const url = `http://bycli-top.test:${fixturePort}/screenshot`;
    const browserSession = 'screenshot-fixture';
    const opened = JSON.parse(await cli(['browser', browserSession, 'open', url]));
    expect(opened).toMatchObject({ page: expect.any(String), url });
    // This deliberately exercises the CLI's plain-text get-url contract used by the helper.
    expect((await cli(['browser', browserSession, 'get', 'url', '--tab', opened.page])).trim()).toBe(url);
    const context = { pageTitle: 'Local fixture visual test', parent: 'Console capture local fixture', section: 'Read-only screenshot', segment: 'Screen 1' };
    await invoke('init', ['--plan-json', JSON.stringify({ title: 'Local fixture visual test', targets: [{ id: 'fixture', url, ...context,
      evidenceType: 'request', origin: 'existing', businessStatus: 'existing',
      use: '本地fixture视觉测试：仅验证真实CLI/helper输出互通，非生产素材或平台附件。' }] })]);
    await invoke('capture', ['--target', 'fixture', '--browser-session', browserSession, '--tab', opened.page, '--bycli', path.join(root, 'dist/src/main.js')]);
    const status = await invoke('status');
    const manifest = JSON.parse(fs.readFileSync(path.join(sessionRoot, sessionDir, 'capture-manifest.json'), 'utf8'));
    const target = Array.isArray(manifest.targets) ? manifest.targets.find((candidate: any) => candidate.id === 'fixture') : manifest.targets?.fixture;
    const capture = target?.captures?.at(-1) ?? manifest.captures?.filter((candidate: any) => candidate.targetId === 'fixture').at(-1);
    expect(capture, JSON.stringify(status)).toMatchObject({ id: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), file: expect.any(String) });
    const pngPath = path.resolve(sessionRoot, sessionDir, capture.file), png = fs.readFileSync(pngPath);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBeGreaterThan(100); expect(png.readUInt32BE(20)).toBeGreaterThan(100);
    expect(createHash('sha256').update(png).digest('hex')).toBe(capture.sha256);
    // This acceptance is an explicitly synthetic fixture attestation, never a production-material review.
    await invoke('review', ['--target', 'fixture', '--review-json', JSON.stringify({
      decision: 'accept', reviewer: 'local-fixture-visual-test', captureId: capture.id, sha256: capture.sha256, context,
      pageIdentityMatches: true, sectionContextMatches: true, legible: true, containsInternalReasoning: false, containsError: false, evidenceSupportsUse: true,
      reason: '本地fixture视觉测试：固定页面身份与章节，验证真实CLI输出互通；PNG留存供root实际查看。',
      evidenceLimits: '仅为本地fixture测试包，不证明生产素材、业务完成或平台附件发送。',
    })]);
    await invoke('validate');
    const packaged = await invoke('package'), verified = await invoke('verify-package');
    const receipt = packaged.receipt ?? packaged;
    expect(receipt).toMatchObject({ archivePath: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), proves: 'file-generation-only' });
    const archive = fs.readFileSync(receipt.archivePath);
    expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(createHash('sha256').update(archive).digest('hex')).toBe(receipt.sha256);
    fs.copyFileSync(pngPath, path.join(run, 'local-fixture.png'));
    fs.copyFileSync(receipt.archivePath, path.join(run, 'local-fixture.zip'));
    fs.writeFileSync(path.join(run, 'fixture-receipt.json'), JSON.stringify({ fixtureOnly: true, helper, receipt, verified }, null, 2));
    console.info(`Fixture-only screenshot evidence (not production material or an attachment): ${run}`);
  }, 60_000);
});
