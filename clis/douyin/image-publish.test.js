import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@sovovs/bycli/registry';

const dirs = [];
function image(name = 'image.png', bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-images-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, { force: true, recursive: true })));
async function command(mode) {
  await import('./draft-images.js');
  await import('./publish-images.js');
  const cmd = getRegistry().get(`douyin/${mode}-images`);
  expect(cmd, 'image command must be registered').toBeDefined();
  return cmd;
}
function fixture({ outcome = 'success', ambiguous = false, disabled = false, disabledPrivate = false, ignoreVisibility = false, titleGated = false, revertTitle = false, login = false, missingField = '', gallery = 'complete', galleryChangesOnTitle = false, creationId = 'draft-123', transport = 'fetch', response = { status_code: 0, aweme_id: '9007199254740993123' } } = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://creator.douyin.com/creator-micro/content/upload', runScripts: 'outside-only' });
  const w = dom.window;
  const uploads = [];
  const actions = [];
  const waits = [];
  let galleryChangePending = false;
  w.fetch = async () => ({ clone: () => ({ json: async () => response }) });
  const originalFetch = w.fetch;
  const originalOpen = w.XMLHttpRequest.prototype.open;
  w.XMLHttpRequest.prototype.send = function() {
    Object.defineProperty(this, 'responseText', { value: JSON.stringify(response) });
    this.dispatchEvent(new w.Event('load'));
  };
  return {
    uploads, actions, waits, window: w, originalFetch, originalOpen,
    async goto() {
      if (login) { w.document.body.textContent = '请先扫码登录并完成身份验证'; return; }
      w.document.body.innerHTML = '<div class="tab-item-BcCLTS">发布图文</div><input type="file" accept="video/*,.mp4">';
      w.document.querySelector('div').addEventListener('click', () => {
        w.document.body.insertAdjacentHTML('beforeend', `<input type="file" accept="image/png,image/jpeg,image/jpg,image/bmp,image/webp,image/tif" multiple>${ambiguous ? '<input type="file" accept="image/*" multiple>' : ''}`);
      }, { once: true });
    },
    async wait(options) {
      waits.push(options);
      if (galleryChangePending && options.time === 0.5) {
        galleryChangePending = false;
        w.document.querySelector('ul').lastElementChild.remove();
        w.document.querySelectorAll('button').forEach(button => button.disabled = false);
      }
    },
    async evaluate(code) { return w.eval(`(${code})()`); },
    async setFileInput(files, selector) {
      const target = w.document.querySelector(selector);
      if (!target?.multiple || !target.accept.includes('image')) throw new Error('wrong upload input');
      uploads.push(files);
      w.history.replaceState(null, '', '/creator-micro/content/post/image');
      w.document.body.innerHTML = `${missingField === 'title' ? '' : '<input placeholder="填写作品标题，为作品获得更多流量">'}${missingField === 'caption' ? '' : '<div contenteditable="true"></div>'}<label><input type="radio" name="visibility" value="public" checked>公开</label><label><input type="radio" name="visibility" value="friends">好友可见</label><label><input type="radio" name="visibility" value="private" ${disabledPrivate ? 'disabled' : ''}>仅自己可见</label><button ${disabled || titleGated ? 'disabled' : ''}>暂存离开</button><button ${disabled || titleGated ? 'disabled' : ''}>发布</button>`;
      if (gallery !== 'unknown') {
        const list = w.document.createElement('ul'); list.setAttribute('aria-label', '图片列表');
        const displayed = gallery === 'partial-error' || gallery === 'incomplete' ? files.slice(0, 1) : files;
        displayed.forEach((file, index) => {
          const item = w.document.createElement('li');
          const thumbnail = w.document.createElement('img'); thumbnail.alt = gallery === 'wrong-identity' ? 'unexpected-file.png' : path.basename(file); thumbnail.src = gallery === 'preview-only' ? 'blob:https://creator.douyin.com/preview' : `https://cdn.example/uploaded-${index}.png`;
          const status = w.document.createElement('span'); status.setAttribute('role', 'status');
          status.textContent = gallery === 'pending' && index === displayed.length - 1 ? '上传中' : '上传成功';
          item.append(thumbnail, status); list.append(item);
        });
        w.document.body.append(list);
        if (gallery === 'partial-error') { const alert = w.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = '第 2 张图片上传失败，请重试'; w.document.body.append(alert); }
        if (gallery === 'unmarked-error') { const error = w.document.createElement('div'); error.textContent = '图片上传失败，请重试'; w.document.body.append(error); }
        if (gallery === 'ambiguous') w.document.body.append(list.cloneNode(true));
      }
      const title = w.document.querySelector('input');
      if (title) title.__reactFiber$fixture = { memoizedProps: { creation_id: creationId }, return: null };
      w.document.execCommand = (command, _show, text) => { if (command === 'insertText') w.document.querySelector('[contenteditable]').textContent = text; return true; };
      if (titleGated) title.addEventListener('input', () => w.document.querySelectorAll('button').forEach(button => button.disabled = !title.value));
      if (revertTitle) title.addEventListener('input', () => title.value = 'old title');
      if (galleryChangesOnTitle) title.addEventListener('input', () => {
        galleryChangePending = true;
        w.document.querySelectorAll('button').forEach(button => button.disabled = true);
      });
      if (ignoreVisibility) w.document.querySelectorAll('label').forEach(label => label.addEventListener('click', event => event.preventDefault()));
      w.document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        actions.push({ action: button.textContent, title: title?.value, caption: w.document.querySelector('[contenteditable]')?.textContent, visibility: w.document.querySelector('input[name="visibility"]:checked')?.closest('label')?.textContent });
        if (button.textContent === '发布') {
          if (outcome !== 'missing') {
            if (transport === 'xhr') { const xhr = new w.XMLHttpRequest(); xhr.open('POST', '/web/api/media/aweme/create_v2/'); xhr.send(); }
            else void w.fetch('/web/api/media/aweme/create_v2/');
          }
        } else if (outcome !== 'missing') {
          w.history.replaceState(null, '', '/creator-micro/content/upload');
          w.document.body.textContent = '你还有上次未发布的图文，是否继续编辑？继续编辑放弃';
        }
      }));
    },
  };
}
describe('douyin image publishing UI contracts', () => {
  it('uploads all validated files and fills title, caption topics and visibility before saving draft', async () => {
    const cmd = await command('draft');
    const first = image(); const second = image('other.jpg', Buffer.from([255, 216, 255, 217]));
    const page = fixture();
    const rows = await cmd.func(page, { images: `${first},${second}`, title: '图文标题', caption: '正文', topics: '旅行,日常', visibility: 'friends' });
    expect(page.uploads).toEqual([[first, second]]);
    expect(page.actions).toEqual([{ action: '暂存离开', title: '图文标题', caption: '正文 #旅行 #日常', visibility: '好友可见' }]);
    expect(rows).toEqual([{ status: '草稿已保存，可在创作中心继续编辑', draft_id: 'draft-123' }]);
  });
  it('confirms publish only from the observed creator response, preserving the string identifier', async () => {
    const cmd = await command('publish'); const page = fixture();
    const rows = await cmd.func(page, { images: image(), title: 'test', now: true, visibility: 'private' });
    expect(page.actions.map(a => a.action)).toEqual(['发布']);
    expect(rows).toEqual([{ status: '已提交发布，等待平台处理', aweme_id: '9007199254740993123', url: 'https://www.douyin.com/note/9007199254740993123' }]);
    expect(page.window.fetch).toBe(page.originalFetch);
    expect(page.window.XMLHttpRequest.prototype.open).toBe(page.originalOpen);
    expect(page.window.__bycliImagePublish).toBeUndefined();
  });
  it('observes XHR submission responses without synthesizing any image API request', async () => {
    const cmd = await command('publish'); const page = fixture({ transport: 'xhr' });
    expect((await cmd.func(page, { images: image(), title: 'test', now: true }))[0].aweme_id).toBe('9007199254740993123');
    expect(page.actions).toHaveLength(1);
  });
  it('requires a draft creation ID before clicking save', async () => {
    const cmd = await command('draft'); const page = fixture({ creationId: '' });
    await expect(cmd.func(page, { images: image(), title: 'test' })).rejects.toThrow(/creation_id/);
    expect(page.actions).toEqual([]);
  });
  it.each(['draft', 'publish'])('rejects missing %s confirmation instead of claiming success', async mode => {
    const cmd = await command(mode); const page = fixture({ outcome: 'missing' });
    await expect(cmd.func(page, { images: image(), title: 'test', now: true })).rejects.toThrow(/无法确认/);
    expect(page.actions).toHaveLength(1);
    expect(page.waits.filter(wait => wait.time === 1)).toHaveLength(30);
    expect(page.window.__bycliImagePublish).toBeUndefined();
  });
  it.each([{ status_code: 1, status_msg: 'rejected', aweme_id: '123' }, { aweme_id: '123' }, { status_code: 0 }, { status_code: 0, aweme_id: 9007199254740992 }])('rejects rejected or ambiguous API outcomes %j', async response => {
    const cmd = await command('publish');
    await expect(cmd.func(fixture({ response }), { images: image(), title: 'test', now: true })).rejects.toThrow(/无法确认|发布失败/);
  });
  it('rejects ambiguous image inputs before injecting files', async () => {
    const cmd = await command('draft'); const page = fixture({ ambiguous: true });
    await expect(cmd.func(page, { images: image(), title: 'test' })).rejects.toThrow(/图片上传/);
    expect(page.uploads).toEqual([]);
  });
  it('reports creator login requirements without injecting files or clicking a write action', async () => {
    const cmd = await command('draft'); const page = fixture({ login: true });
    await expect(cmd.func(page, { images: image(), title: 'test' })).rejects.toThrow(/登录/);
    expect(page.uploads).toEqual([]);
    expect(page.actions).toEqual([]);
  });
  it('rejects a disabled action without clicking', async () => {
    const cmd = await command('publish'); const page = fixture({ disabled: true });
    await expect(cmd.func(page, { images: image(), title: 'test', now: true })).rejects.toThrow(/不可用|编辑页/);
    expect(page.actions).toEqual([]);
  });
  it('rejects disabled private visibility while public remains selected before publishing', async () => {
    const cmd = await command('publish'); const page = fixture({ disabledPrivate: true });
    await expect(cmd.func(page, { images: image(), title: 'test', now: true, visibility: 'private' })).rejects.toThrow(/visibility/);
    expect(page.window.document.querySelector('input[name="visibility"]:checked').value).toBe('public');
    expect(page.actions).toEqual([]);
  });
  it('rejects a visibility change that did not become selected before publishing', async () => {
    const cmd = await command('publish'); const page = fixture({ ignoreVisibility: true });
    await expect(cmd.func(page, { images: image(), title: 'test', now: true, visibility: 'private' })).rejects.toThrow(/visibility/);
    expect(page.window.document.querySelector('input[name="visibility"]:checked').value).toBe('public');
    expect(page.actions).toEqual([]);
  });
  it('fills required fields before waiting for a title-gated publish button to enable', async () => {
    const cmd = await command('publish'); const page = fixture({ titleGated: true });
    const rows = await cmd.func(page, { images: image(), title: 'required title', now: true });
    expect(rows[0].aweme_id).toBe('9007199254740993123');
    expect(page.actions[0].title).toBe('required title');
    expect(page.waits.filter(wait => wait.time === 0.5)).toHaveLength(1);
  });
  it('rejects an input value that did not retain the requested title before publishing', async () => {
    const cmd = await command('publish'); const page = fixture({ revertTitle: true });
    await expect(cmd.func(page, { images: image(), title: 'required title', now: true })).rejects.toThrow(/title/);
    expect(page.actions).toEqual([]);
  });
  it.each(['draft', 'publish'])('rejects a partial image upload with a visible failure before %s', async mode => {
    const cmd = await command(mode); const page = fixture({ gallery: 'partial-error' });
    await expect(cmd.func(page, { images: [image(), image('second.png')], title: 'test', now: true })).rejects.toThrow(/图片.*上传|image-upload/);
    expect(page.actions).toEqual([]);
  });
  it.each(['pending', 'incomplete', 'unknown', 'ambiguous', 'wrong-identity', 'preview-only', 'unmarked-error'])('does not submit an image gallery with %s completion evidence', async gallery => {
    const cmd = await command('publish'); const page = fixture({ gallery });
    await expect(cmd.func(page, { images: [image(), image('second.png')], title: 'test', now: true })).rejects.toThrow(/图片.*上传|image-upload/);
    expect(page.actions).toEqual([]);
  });
  it('rechecks the complete gallery immediately before clicking the write action', async () => {
    const cmd = await command('publish'); const page = fixture({ galleryChangesOnTitle: true });
    await expect(cmd.func(page, { images: [image(), image('second.png')], title: 'test', now: true })).rejects.toThrow(/图片.*上传|image-upload/);
    expect(page.actions).toEqual([]);
  });
  it('waits for explicit completion of every gallery item before submitting', async () => {
    const cmd = await command('publish'); const page = fixture({ gallery: 'pending' });
    const wait = page.wait.bind(page);
    page.wait = async options => {
      await wait(options);
      if (page.window.document.querySelector('ul') && options.time === 0.5) {
        page.window.document.querySelectorAll('ul [role="status"]').forEach(status => status.textContent = '上传成功');
      }
    };
    const rows = await cmd.func(page, { images: [image(), image('second.png')], title: 'test', now: true });
    expect(rows[0].aweme_id).toBe('9007199254740993123');
    expect(page.actions).toHaveLength(1);
    expect(page.waits.filter(options => options.time === 0.5)).toHaveLength(2);
  });
  it('rejects a missing caption editor without submitting', async () => {
    const cmd = await command('draft'); const page = fixture({ missingField: 'caption' });
    await expect(cmd.func(page, { images: image(), title: 'test', caption: 'caption' })).rejects.toThrow(/caption/);
    expect(page.actions).toEqual([]);
  });
  it('requires explicit immediate mode for image publishing', async () => {
    const cmd = await command('publish'); const page = fixture();
    await expect(cmd.func(page, { images: image(), title: 'test' })).rejects.toThrow(/--now/);
    await expect(cmd.func(page, { images: image(), title: 'test', now: true, schedule: 'future' })).rejects.toThrow(/定时/);
    expect(page.uploads).toEqual([]);
  });
  it('enforces the live creator limit of 35 images before navigation', async () => {
    const cmd = await command('draft'); const page = fixture();
    await expect(cmd.func(page, { images: Array.from({ length: 36 }, () => image()), title: 'test' })).rejects.toThrow(/35/);
    expect(page.window.document.body.textContent).toBe('');
  });
  it('enforces the live creator limit of 50MB per image before navigation', async () => {
    const cmd = await command('draft'); const page = fixture();
    const large = image(); fs.truncateSync(large, 50 * 1024 * 1024 + 1);
    await expect(cmd.func(page, { images: large, title: 'test' })).rejects.toThrow(/50/);
    expect(page.window.document.body.textContent).toBe('');
  });
  it.each([
    { title: '' }, { title: 'a'.repeat(31) }, { title: 'test', caption: 'a'.repeat(1000), topics: 'x' },
    { title: 'test', visibility: 'nobody' }, { title: 'test', topics: 'has space' },
  ])('validates fields before navigation: %j', async overrides => {
    const cmd = await command('draft'); const page = fixture();
    await expect(cmd.func(page, { images: image(), ...overrides })).rejects.toThrow();
    expect(page.window.document.body.textContent).toBe('');
  });
  it.each([
    ['missing', '/nonexistent/test.png'],
    ['directory', () => path.dirname(image())],
    ['empty', () => image('empty.png', Buffer.alloc(0))],
    ['invalid signature', () => image('fake.png', Buffer.from('not a PNG'))],
    ['unsupported extension', () => image('image.mp4')],
    ['remote URL', 'https://example.com/a.png'],
  ])('rejects %s files before browser navigation', async (_reason, source) => {
    const cmd = await command('draft'); const page = fixture();
    await expect(cmd.func(page, { images: typeof source === 'function' ? source() : source, title: 'test' })).rejects.toThrow();
    expect(page.uploads).toEqual([]);
    expect(page.window.document.body.textContent).toBe('');
  });
});
