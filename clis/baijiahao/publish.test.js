import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, validatePublish, collectSavedId } from './_shared/publish.js';
import { publisherScript } from './_shared/publish-dom.js';
import { saveOperation, readOperation } from './_shared/operation.js';

const OP = { version: 1, site: 'baijiahao', kind: 'video', operationId: '52a5e708-9f55-4e02-bf4d-7ea02a7ca5b0',
  editorSession: 'baijiahao-publish-52a5e708-9f55-4e02-bf4d-7ea02a7ca5b0', accountId: '1879445573191648',
  title: '验收视频', body: '', images: [], coverKeys: ['cover1', 'cover2'], imageKeys: [],
  status: 'prepared', phase: 'prepared', aiGenerated: 'yes', submitted: false,
  createdAt: '2026-10-19T14:00:00Z', id: '1879458669366991738', nid: '6134461117009265959' };
async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bycli-baijiahao-test-')), file = join(dir, 'operation.json');
  await saveOperation(file, { ...OP, ...options.operation });
  const clicks = [];
  const page = { contextId: 'test', goto: async () => {}, focusWindow: async () => {}, wait: async () => {},
    startNetworkCapture: async () => true,
    readNetworkCapture: async () => [{ method: 'GET', url: 'https://baijiahao.baidu.com/pcui/article/lists', requestHeaders: { token: 'test-token' } }],
    evaluate: async code => {
      if (code === 'location.origin') return 'https://baijiahao.baidu.com';
      if (code.includes('const r=await fetch(')) {
        const data = code.includes('/builder/app/appinfo') ? { user: { app_id: options.accountId || OP.accountId } }
          : code.includes('/pcui/article/edit?') ? { article: { id: OP.id, app_id: OP.accountId, type: 'video', title: options.remoteTitle || OP.title, status: 'draft', nid: OP.nid } }
            : { list: [{ article_id: OP.id, nid: OP.nid, type: 'video', title: OP.title, status: 'publish', share_url: `https://mbd.baidu.com/newspage/data/videolanding?nid=sv_${OP.nid}` }], page: { totalCount: 1 } };
        return { status: 200, body: { errno: 0, data } };
      }
      return { operationId: OP.operationId, id: OP.id, title: options.editorTitle || OP.title, aiSelected: true, mediaReady: true,
        coversReady: true, coverKeys: OP.coverKeys, imageKeys: [], verification: options.verification ?? false, selector: '[data-testid=publish-btn]' };
    },
    click: async selector => {
      clicks.push(selector); const journal = JSON.parse(await readFile(file, 'utf8'));
      if (options.saveClick) { expect(journal.phase).toBe('saving'); expect(journal.submitted).toBe(false); }
      else expect(journal.submitted).toBe(true);
      if (options.clickError) throw new Error('lost connection');
    },
  };
  return { file, page, clicks, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
describe('Baijiahao durable publishing workflow', () => {
  it('does not drain a pending save request before its response can be captured', async () => {
    let complete = false, drains = 0;
    const page = { evaluate: async code => code.includes("performance.getEntriesByType") ? complete : { id: null }, wait: async () => {},
      readNetworkCapture: async () => { drains++; return [{ method: 'POST', url: 'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft', responseStatus: 200, responsePreview: JSON.stringify({ errno: 0, ret: { id: OP.id, title: OP.title } }) }]; } };
    expect(await collectSavedId(page, { ...OP, id: undefined, saveStartedAt: 100 })).toBeNull();
    expect(drains).toBe(0); complete = true;
    expect(await collectSavedId(page, { ...OP, id: undefined, saveStartedAt: 100 })).toBe(OP.id); expect(drains).toBe(1);
  });
  it('records unknown save intent before the native click', async () => {
    const b = await setup({ operation: { phase: 'save', status: 'preparing' }, saveClick: true, clickError: true });
    try {
      await expect(publish(b.page, { operation: b.file, mode: 'resume', execute: true }, 'video', () => b.page)).rejects.toThrow('lost connection');
      expect(await readOperation(b.file)).toMatchObject({ phase: 'saving', submitted: false, status: 'preparation_unknown' });
      expect(b.clicks).toHaveLength(1);
    } finally { await b.cleanup(); }
  });
  it('persists attempted submission before clicking and never repeats an ambiguous submit', async () => {
    const b = await setup({ clickError: true });
    try {
      const args = { operation: b.file, mode: 'submit', 'user-confirmed': true, execute: true };
      await expect(publish(b.page, args, 'video', () => b.page)).rejects.toThrow('lost connection');
      expect((await readOperation(b.file)).submitted).toBe(true);
      await publish(b.page, args, 'video', () => b.page); expect(b.clicks).toHaveLength(1);
    } finally { await b.cleanup(); }
  });
  it.each([{ accountId: '123' }, { editorTitle: 'changed' }, { remoteTitle: 'changed' }])('fails closed before submit when account or saved content changes: %j', async options => {
    const b = await setup(options);
    try { await expect(publish(b.page, { operation: b.file, mode: 'submit', 'user-confirmed': true, execute: true }, 'video', () => b.page)).rejects.toThrow(); expect(b.clicks).toHaveLength(0); } finally { await b.cleanup(); }
  });
  it('reconciles the exact published work without clicking or creating an editor', async () => {
    const b = await setup({ operation: { submitted: true, status: 'verification_required' } });
    try {
      const rows = await publish(b.page, { operation: b.file, mode: 'status' }, 'video', () => { throw new Error('must not create editor'); });
      expect(rows[0]).toMatchObject({ id: OP.id, nid: OP.nid, status: 'published' }); expect(b.clicks).toHaveLength(0);
    } finally { await b.cleanup(); }
  });
  it('requires explicit execution but permits read-only status', () => {
    expect(() => validatePublish({ operation: 'x', mode: 'submit' })).toThrow();
    expect(() => validatePublish({ operation: 'x', mode: 'status' })).not.toThrow();
  });
  it('rejects malformed or foreign operation journals', async () => {
    const b = await setup();
    try { await writeFile(b.file, JSON.stringify({ ...OP, site: 'zhihu' })); await expect(readOperation(b.file)).rejects.toThrow(); } finally { await b.cleanup(); }
  });
});
describe('Baijiahao actual DOM driver', () => {
  it('removes editor-only image helpers and empty cursor markers while retaining user captions and emoji joiners', () => {
    const dom = new JSDOM('<form><div data-testid="news-title-input"><div contenteditable="true">标题</div></div><iframe id="ueditor_0"></iframe></form>', { url: 'https://baijiahao.baidu.com/builder/rc/edit?type=news', runScripts: 'outside-only' });
    try {
      const body = dom.window.document.querySelector('iframe').contentDocument.body;
      body.innerHTML = '<p>正文👩‍💻</p><p><img src="https://baijiahao.baidu.com/bjh/picproxy?param=one"><span class="bjh-clear-at-out-put">编辑 搜图</span></p><p class="bjh-image-caption ue_t" data-bjh-caption-text="请点击输入图片描述">请点击输入图片描述</p><p class="bjh-image-caption ue_t" data-bjh-caption-text="请点击输入图片描述">用户的图片说明</p><p>‍<br></p>';
      const state = dom.window.eval(publisherScript('article', 'status', { ...OP, id: undefined }));
      expect(state.body).toBe('正文👩‍💻用户的图片说明');
    } finally { dom.window.close(); }
  });
  it('confirms the selected AI radio in the captured declaration dialog', () => {
    const html = readFileSync(new URL('./__fixtures__/ai-dialog.html', import.meta.url), 'utf8');
    const dom = new JSDOM('<div id="root"><form><input placeholder="请选择创作声明"></form></div>' + html, { url: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', runScripts: 'outside-only' });
    try {
      const op = { ...OP, id: undefined };
      const radio = [...dom.window.document.querySelectorAll('input[type=radio]')].find(n => n.closest('div').textContent === '含AI生成内容');
      radio.checked = false;
      dom.window.eval(publisherScript('video', 'bind', op));
      const initial = dom.window.eval(publisherScript('video', 'ai', op));
      expect(dom.window.document.querySelector(initial.selector).textContent).toBe('含AI生成内容');
      radio.checked = true;
      const selected = dom.window.eval(publisherScript('video', 'ai', op));
      expect(dom.window.document.querySelector(selected.selector).tagName).toBe('BUTTON');
      expect(dom.window.document.querySelector(selected.selector).textContent).toBe('确定');
    } finally { dom.window.close(); }
  });
  it('detects metadata on the actual uploaded-video DOM whose player is outside the form', () => {
    const html = readFileSync(new URL('./__fixtures__/uploaded-video-editor.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', runScripts: 'outside-only' });
    try {
      Object.defineProperty(dom.window.document.querySelector('video'), 'duration', { value: 174.96 });
      const state = dom.window.eval(publisherScript('video', 'status', { ...OP, id: undefined }));
      expect(state.mediaReady).toBe(true); expect(state.title).toBe('本体江湖成片');
    } finally { dom.window.close(); }
  });
  it('supports the initial video screen before the platform mounts a form', () => {
    const html = readFileSync(new URL('./__fixtures__/initial-video.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', runScripts: 'outside-only' });
    try {
      const op = { ...OP, id: undefined };
      dom.window.eval(publisherScript('video', 'bind', op));
      const state = dom.window.eval(publisherScript('video', 'video', op));
      expect(state.selector).toBeTruthy(); expect(dom.window.document.querySelector(state.selector).type).toBe('file'); expect(state.mediaReady).toBe(false);
    } finally { dom.window.close(); }
  });
  it('rejects another draft ID rather than adopting the current tab', () => {
    const dom = new JSDOM('<form></form>', { url: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123', runScripts: 'outside-only' });
    try { expect(dom.window.eval(publisherScript('video', 'bind', OP))).toEqual({ error: 'wrong_draft' }); } finally { dom.window.close(); }
  });
});
