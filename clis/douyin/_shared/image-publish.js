import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { unwrapEvaluateResult } from './evaluate-result.js';

export const imageArgs = [
    { name: 'images', required: true, help: '本地 JPEG/PNG/WebP 图片路径，多张用逗号分隔' },
    { name: 'title', required: true, help: '图文标题（≤30字）' },
    { name: 'caption', default: '', help: '正文（含话题总计≤1000字）' },
    { name: 'topics', default: '', help: '话题名称，逗号分隔，自动添加 # 前缀' },
    { name: 'visibility', default: 'public', choices: ['public', 'friends', 'private'] },
];
const visibilityLabels = { public: '公开', friends: '好友可见', private: '仅自己可见' };
const evaluate = async (page, code) => unwrapEvaluateResult(await page.evaluate(code));

function validateOptions(kwargs, mode) {
    if (mode === 'publish') {
        if (kwargs.schedule !== undefined) throw new ArgumentError('图文暂不支持定时发布');
        if (kwargs.now !== true) throw new ArgumentError('图文发布必须显式指定 --now');
    }
    const names = Array.isArray(kwargs.images) ? kwargs.images : String(kwargs.images || '').split(',');
    if (!names.length || names.some(name => typeof name !== 'string' || !name.trim())) throw new ArgumentError('至少提供一张本地图片');
    // Confirmed on creator center's image-upload tab (2026-10-15).
    if (names.length > 35) throw new ArgumentError('最多支持上传 35 张图片');
    const files = names.map(name => {
        if (/^[a-z]+:\/\//i.test(name.trim())) throw new ArgumentError('图片必须是本地文件');
        const file = path.resolve(name.trim());
        const ext = path.extname(file).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new ArgumentError(`不支持的图片格式: ${ext}`);
        let stat;
        try { stat = fs.statSync(file); } catch { throw new ArgumentError(`图片文件不存在或无法读取: ${file}`); }
        if (!stat.isFile() || stat.size === 0) throw new ArgumentError(`图片必须是非空普通文件: ${file}`);
        if (stat.size > 50 * 1024 * 1024) throw new ArgumentError(`图片不能超过 50MB: ${file}`);
        const header = Buffer.alloc(12);
        let fd;
        try { fd = fs.openSync(file, 'r'); fs.readSync(fd, header, 0, 12, 0); }
        catch { throw new ArgumentError(`图片文件无法读取: ${file}`); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        const valid = ext === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : ext === '.webp' ? header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
            : header[0] === 255 && header[1] === 216 && header[2] === 255;
        if (!valid) throw new ArgumentError(`图片内容与扩展名不匹配: ${file}`);
        return file;
    });
    if (new Set(files).size !== files.length) throw new ArgumentError('图片路径不能重复');
    const title = typeof kwargs.title === 'string' ? kwargs.title.trim() : '';
    if (!title || title.length > 30) throw new ArgumentError('标题必须为 1–30 字');
    const topics = String(kwargs.topics || '').split(',').map(s => s.trim().replace(/^#+/, '')).filter(Boolean);
    if (topics.some(topic => /\s|#/.test(topic))) throw new ArgumentError('话题名称不能包含空格或 #');
    const caption = [kwargs.caption || '', ...topics.map(topic => `#${topic}`)].filter(Boolean).join(' ');
    if (caption.length > 1000) throw new ArgumentError('正文与话题不能超过 1000 字');
    const visibilityLabel = visibilityLabels[kwargs.visibility || 'public'];
    if (!visibilityLabel) throw new ArgumentError('无效的可见范围');
    return { files, imageNames: files.map(file => path.basename(file)), title, caption, visibilityLabel };
}

async function selectUploadInput(page, count) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const state = await evaluate(page, `() => {
            const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(el =>
                !el.disabled && ((el.accept || '').includes('image/') || /\\.(jpe?g|png|webp)/i.test(el.accept || '')) && (${count} === 1 || el.multiple));
            if (inputs.length > 1) return { ambiguous: true };
            if (inputs.length === 1) {
                document.querySelectorAll('[data-bycli-images-input]').forEach(el => el.removeAttribute('data-bycli-images-input'));
                inputs[0].setAttribute('data-bycli-images-input', '1');
                return { selector: '[data-bycli-images-input="1"]' };
            }
            const tab = Array.from(document.querySelectorAll('button,[role="tab"],label,div')).find(el =>
                ['发布图文', '图文'].includes((el.textContent || '').trim()));
            if (tab instanceof HTMLElement) tab.click();
            return { login: /扫码登录|登录后|身份验证/.test(document.body?.innerText || document.body?.textContent || '') };
        }`);
        if (state?.selector) return state.selector;
        if (state?.ambiguous) throw new CommandExecutionError('图片上传输入框不唯一，已停止');
        if (state?.login) throw new AuthRequiredError('creator.douyin.com', '请先登录并完成身份验证');
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('未找到可用的图片上传输入框，请确认创作中心已开放图文发布');
}

async function waitComposer(page, action) {
    for (let attempt = 0; attempt < 120; attempt++) {
        const ready = await evaluate(page, `() => !!Array.from(document.querySelectorAll('input')).find(el =>
            (el.placeholder || '').includes('填写作品标题')) && !!Array.from(document.querySelectorAll('button')).find(el =>
            (el.textContent || '').trim() === ${JSON.stringify(action)})`);
        if (ready === true) return;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('等待图文编辑页超时或操作按钮不可用，未提交');
}

const visibilityControlJs = `(label) => label.querySelector('input[type="radio"],[role="radio"]')
    || (label.htmlFor ? document.getElementById(label.htmlFor) : null)
    || (label.getAttribute('role') === 'radio' ? label : null)`;

// The image composer has not been inspected after a real upload. Accept only
// explicit semantic gallery evidence; unknown markup must never imply success.
// A local FileList, loaded preview, or enabled publish button is insufficient.
function imageUploadValidationJs(options) {
    return `
        const exposed = el => !el.closest('[hidden],[aria-hidden="true"]');
        const notices = Array.from(document.querySelectorAll('[role="alert"],[role="status"]')).filter(exposed);
        const visibleText = document.body?.innerText || document.body?.textContent || '';
        if (/上传失败|上传出错|upload failed/i.test(visibleText) || notices.some(el => /上传失败|上传出错|upload failed/i.test(el.textContent || ''))) return { error: 'image-upload-failed', fatal: true };
        const galleries = Array.from(document.querySelectorAll('[role="list"][aria-label],ul[aria-label],ol[aria-label]')).filter(el => exposed(el) && /图片|图文|images|photos/i.test(el.getAttribute('aria-label') || ''));
        if (galleries.length !== 1) return { error: 'image-upload-gallery-unconfirmed', fatal: galleries.length > 1 };
        const gallery = galleries[0];
        const items = Array.from(gallery.querySelectorAll(':scope > [role="listitem"],:scope > li'));
        const expectedNames = ${JSON.stringify(options.imageNames)};
        if (items.length !== expectedNames.length) return { error: 'image-upload-count-unconfirmed', fatal: items.length > expectedNames.length };
        if (gallery.querySelector('[role="progressbar"]')) return { error: 'image-upload-pending' };
        for (let index = 0; index < items.length; index++) {
            const thumbnails = items[index].querySelectorAll('img');
            const statuses = Array.from(items[index].querySelectorAll('[role="status"]')).filter(exposed);
            if (thumbnails.length !== 1 || thumbnails[0].alt !== expectedNames[index]) return { error: 'image-upload-identity-unconfirmed' };
            if (!/^https?:/.test(thumbnails[0].src)) return { error: 'image-upload-preview-only' };
            if (statuses.length !== 1 || !/^(上传成功|已上传|uploaded|upload complete)$/i.test((statuses[0].textContent || '').trim())) return { error: 'image-upload-pending-or-unconfirmed' };
        }
    `;
}

async function waitImagesUploaded(page, options) {
    let reason = 'image-upload-unconfirmed';
    for (let attempt = 0; attempt < 120; attempt++) {
        const state = await evaluate(page, `() => { ${imageUploadValidationJs(options)} return { ok: true }; }`);
        if (state?.ok) return;
        reason = state?.error || reason;
        if (state?.fatal) break;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError(`图片上传状态无法确认: ${reason}，未提交`);
}

function composerValidationJs(options) {
    return `
        ${imageUploadValidationJs(options)}
        const title = Array.from(document.querySelectorAll('input')).find(el => (el.placeholder || '').includes('填写作品标题'));
        if (!title || title.value !== ${JSON.stringify(options.title)}) return { error: 'title-value-unconfirmed' };
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
        if (editors.length !== 1 || editors[0].textContent !== ${JSON.stringify(options.caption)}) return { error: 'caption-value-unconfirmed' };
        const controlFor = ${visibilityControlJs};
        const labels = Array.from(document.querySelectorAll('label')).filter(label => ['公开', '好友可见', '仅自己可见'].includes((label.textContent || '').trim()));
        const targets = labels.filter(label => (label.textContent || '').trim() === ${JSON.stringify(options.visibilityLabel)});
        if (targets.length !== 1) return { error: 'visibility-missing-or-ambiguous' };
        const target = controlFor(targets[0]);
        if (!target || target.disabled || target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true' || targets[0].getAttribute('aria-disabled') === 'true') return { error: 'visibility-unavailable' };
        const selected = labels.filter(label => {
            const control = controlFor(label);
            return control instanceof HTMLInputElement ? control.checked : control?.getAttribute('aria-checked') === 'true';
        });
        if (selected.length !== 1 || selected[0] !== targets[0]) return { error: 'visibility-selection-unconfirmed' };
    `;
}

async function waitFieldsApplied(page, options) {
    let reason = 'fields-unconfirmed';
    for (let attempt = 0; attempt < 20; attempt++) {
        const state = await evaluate(page, `() => { ${composerValidationJs(options)} return { ok: true }; }`);
        if (state?.ok) return;
        reason = state?.error || reason;
        await page.wait({ time: 0.1 });
    }
    throw new CommandExecutionError(`图文表单状态无法确认: ${reason}，未提交`);
}

async function waitActionEnabled(page, action) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const state = await evaluate(page, `() => {
            const buttons = Array.from(document.querySelectorAll('button')).filter(el => (el.textContent || '').trim() === ${JSON.stringify(action)});
            return { ambiguous: buttons.length > 1, enabled: buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-disabled') !== 'true' };
        }`);
        if (state?.ambiguous) throw new CommandExecutionError('图文操作按钮不唯一，未提交');
        if (state?.enabled) return;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('图文操作按钮不可用，未提交');
}

async function fillComposer(page, options) {
    const result = await evaluate(page, `() => {
        const title = Array.from(document.querySelectorAll('input')).find(el => (el.placeholder || '').includes('填写作品标题'));
        if (!(title instanceof HTMLInputElement)) return 'title-input-missing';
        const titleValue = ${JSON.stringify(options.title)};
        const props = title[Object.keys(title).find(key => key.startsWith('__reactProps$'))];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, titleValue);
        if (props?.onChange) props.onChange({ target: title, currentTarget: title });
        else {
            title.dispatchEvent(new Event('input', { bubbles: true }));
            title.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (props?.onBlur) props.onBlur({ target: title, currentTarget: title, relatedTarget: null });
        else title.dispatchEvent(new Event('blur', { bubbles: true }));
        const caption = ${JSON.stringify(options.caption)};
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
        if (editors.length !== 1) return 'caption-editor-missing-or-ambiguous';
        const editor = editors[0]; editor.focus(); editor.textContent = '';
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, caption);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        const labels = Array.from(document.querySelectorAll('label')).filter(el =>
            (el.textContent || '').trim() === ${JSON.stringify(options.visibilityLabel)});
        if (labels.length !== 1) return 'visibility-missing-or-ambiguous';
        const controlFor = ${visibilityControlJs};
        const control = controlFor(labels[0]);
        if (!control || control.disabled || control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true' || labels[0].getAttribute('aria-disabled') === 'true') return 'visibility-unavailable';
        labels[0].click();
        return '';
    }`);
    if (result !== '') throw new CommandExecutionError(`填写图文表单失败: ${result || 'unknown'}`);
    await waitFieldsApplied(page, options);
}

// Observe only the already established create_v2 response contract. No image API
// request schema is synthesized, and no request/cookie/token data is retained.
async function observePublish(page) {
    await evaluate(page, `() => {
        const originalFetch = window.fetch;
        const originalOpen = XMLHttpRequest.prototype.open;
        const state = { result: null };
        const capture = value => {
            if (!value || typeof value !== 'object') return;
            state.result = { status_code: value.status_code, aweme_id: value.aweme_id ?? value.item_id };
        };
        const matches = url => /\\/web\\/api\\/media\\/aweme\\/create_v2\\//.test(String(url));
        const wrappedFetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            if (matches(args[0]?.url || args[0])) {
                try { capture(await response.clone().json()); } catch {}
            }
            return response;
        };
        const wrappedOpen = function(method, url, ...args) {
            if (matches(url)) this.addEventListener('load', () => {
                try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
            }, { once: true });
            return originalOpen.call(this, method, url, ...args);
        };
        window.fetch = wrappedFetch;
        XMLHttpRequest.prototype.open = wrappedOpen;
        state.cleanup = () => {
            if (window.fetch === wrappedFetch) window.fetch = originalFetch;
            if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
        };
        window.__bycliImagePublish = state;
    }`);
}

async function clickAction(page, action, draft, options) {
    const result = await evaluate(page, `() => {
        ${composerValidationJs(options)}
        const buttons = Array.from(document.querySelectorAll('button')).filter(el =>
            (el.textContent || '').trim() === ${JSON.stringify(action)} && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
        if (buttons.length !== 1) return { error: '操作按钮不可用或不唯一' };
        let creationId = '';
        if (${draft}) {
            const title = Array.from(document.querySelectorAll('input')).find(el => (el.placeholder || '').includes('填写作品标题'));
            let fiber = title?.[Object.keys(title || {}).find(key => key.startsWith('__reactFiber$'))];
            while (fiber) {
                if (typeof fiber.memoizedProps?.creation_id === 'string' && fiber.memoizedProps.creation_id) { creationId = fiber.memoizedProps.creation_id; break; }
                fiber = fiber.return;
            }
            if (!creationId) return { error: '无法确认草稿 creation_id，未点击保存' };
        }
        buttons[0].click();
        return { creationId };
    }`);
    if (!result || result.error) throw new CommandExecutionError(result?.error || '图文操作未执行');
    return result.creationId;
}

async function waitResult(page, mode, creationId) {
    for (let attempt = 0; attempt < 30; attempt++) {
        if (mode === 'draft') {
            const saved = await evaluate(page, `() => location.pathname.includes('/creator-micro/content/upload') && /继续编辑/.test(document.body?.innerText || document.body?.textContent || '')`);
            if (saved === true) return [{ status: '草稿已保存，可在创作中心继续编辑', draft_id: creationId }];
        } else {
            const response = await evaluate(page, '() => window.__bycliImagePublish?.result || null');
            if (response) {
                if (response.status_code !== 0) throw new CommandExecutionError('图文发布失败或无法确认平台状态，请在创作中心查看平台提示');
                if (typeof response.aweme_id !== 'string' || !response.aweme_id.trim()) throw new CommandExecutionError('无法确认图文发布结果: 缺少字符串作品 ID，请在创作中心确认后再重试');
                return [{ status: '已提交发布，等待平台处理', aweme_id: response.aweme_id, url: `https://www.douyin.com/note/${response.aweme_id}` }];
            }
        }
        await page.wait({ time: 1 });
    }
    throw new CommandExecutionError('无法确认图文操作结果，请在创作中心确认后再重试，避免重复提交');
}

export async function runImageComposer(page, kwargs, mode) {
    const options = validateOptions(kwargs, mode);
    if (!page.setFileInput) throw new CommandExecutionError('当前浏览器适配器不支持文件注入');
    const action = mode === 'draft' ? '暂存离开' : '发布';
    await page.goto('https://creator.douyin.com/creator-micro/content/upload');
    const selector = await selectUploadInput(page, options.files.length);
    await page.setFileInput(options.files, selector);
    await waitComposer(page, action);
    await waitImagesUploaded(page, options);
    await fillComposer(page, options);
    await waitActionEnabled(page, action);
    if (mode === 'publish') await observePublish(page);
    try {
        const creationId = await clickAction(page, action, mode === 'draft', options);
        return await waitResult(page, mode, creationId);
    } finally {
        if (mode === 'publish') {
            try { await evaluate(page, '() => { window.__bycliImagePublish?.cleanup?.(); delete window.__bycliImagePublish; }'); }
            catch { /* Navigation may have already discarded the observer. */ }
        }
    }
}
