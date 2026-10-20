import { CliError } from '@sovovs/bycli/errors';
import { parseTarget } from './target.js';

export function normalizeDraftText(text) {
    return String(text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
}

function booleanOption(value, fallback, name) {
    if (value === undefined) return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new CliError('INVALID_INPUT', `${name} must be true or false`);
}

export function resolveDraftOptions(kwargs) {
    const raw = String(kwargs.target ?? '').trim();
    const target = parseTarget(/^\d+$/.test(raw) ? `question:${raw}` : raw);
    if (!['question', 'answer'].includes(target.kind)) {
        throw new CliError('UNSUPPORTED_TARGET', 'answer-waiting-draft requires a question or your own answer');
    }
    const mode = kwargs.mode ?? 'auto';
    const existing = kwargs.existing ?? 'error';
    const timeout = Number(kwargs.timeout ?? 30);
    if (!['auto', 'new', 'edit'].includes(mode)) throw new CliError('INVALID_INPUT', 'Mode must be auto, new, or edit');
    if (!['error', 'replace', 'append', 'prepend'].includes(existing)) throw new CliError('INVALID_INPUT', 'Existing content policy must be error, replace, append, or prepend');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new CliError('INVALID_INPUT', 'Timeout must be an integer from 1 to 120 seconds');
    if (mode === 'new' && target.kind === 'answer') throw new CliError('INVALID_INPUT', 'Mode new cannot target an existing answer');
    const dryRun = booleanOption(kwargs['dry-run'], false, '--dry-run');
    const execute = booleanOption(kwargs.execute, false, '--execute');
    if (dryRun && execute) throw new CliError('INVALID_INPUT', 'Use --dry-run or --execute, not both');
    return {
        questionId: target.kind === 'question' ? target.id : target.questionId,
        answerId: target.kind === 'answer' ? target.id : '',
        url: target.url, mode, existing, timeout, dryRun, execute,
        closeEditor: booleanOption(kwargs['close-editor'], true, '--close-editor'),
        separator: kwargs.separator ?? '\n\n',
        prefix: kwargs.prefix ?? '', suffix: kwargs.suffix ?? '',
        expectedTitle: kwargs['expected-title'] ?? '',
    };
}

export function planDraftContent(current, payload, policy, separator, hasRichContent = false) {
    const before = normalizeDraftText(current);
    const incoming = normalizeDraftText(payload);
    if (before === incoming) return { changed: false, expected: before, insertion: '', position: 'replace' };
    if ((before || hasRichContent) && policy === 'error') {
        throw new CliError('DRAFT_EXISTS', 'The editor already contains different text', 'Use --existing replace, append, or prepend to choose how to update it');
    }
    if (!before) separator = '';
    if ((before || hasRichContent) && policy === 'append') return { changed: true, expected: before + separator + incoming, insertion: separator + incoming, position: 'append' };
    if ((before || hasRichContent) && policy === 'prepend') return { changed: true, expected: incoming + separator + before, insertion: incoming + separator, position: 'prepend' };
    return { changed: true, expected: incoming, insertion: incoming, position: 'replace' };
}

// These functions run in the browser. Keep them self-contained for serialization
// and fixture tests; only inspect the question's answer form, never comments.
export function inspectDraftPage(questionId) {
    const clean = text => String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
    const visible = node => {
        for (let n = node; n; n = n.parentElement) {
            if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
            const style = getComputedStyle(n);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    };
    if (/^\/(signin|signup|account\/unhuman)(\/|$)/.test(location.pathname)) return { status: 'auth' };
    const path = location.pathname.match(/^\/question\/(\d+)(?:\/answer\/(\d+))?\/?$/);
    if (location.origin !== 'https://www.zhihu.com' || path?.[1] !== questionId) return { status: 'wrong_target' };
    const title = clean(document.querySelector('h1')?.textContent);
    if (Array.from(document.querySelectorAll('button')).some(b => visible(b) && clean(b.textContent) === '撤销删除')) return { status: 'deleted', title };
    let ownAnswerUrl = '';
    for (const link of document.querySelectorAll('a[href]')) {
        if (clean(link.textContent) !== '查看我的回答' || !visible(link)) continue;
        const url = new URL(link.getAttribute('href'), location.href);
        if (url.origin === location.origin && new RegExp('^/question/' + questionId + '/answer/\\d+/?$').test(url.pathname)) {
            ownAnswerUrl = url.origin + url.pathname;
            break;
        }
    }
    const forms = Array.from(document.querySelectorAll('form.AnswerForm')).filter(visible);
    const editors = forms.flatMap(form => Array.from(form.querySelectorAll('.public-DraftEditor-content[contenteditable="true"]')).filter(visible));
    const base = { url: location.href, title, answerId: path[2] || '', ownAnswerUrl };
    if (editors.length > 1) return { ...base, status: 'ambiguous' };
    if (!editors.length) return { ...base, status: 'page' };
    const editor = editors[0];
    const form = editor.closest('form.AnswerForm');
    // New publisher renders the action bar beside the form inside this portal.
    // Stay inside that answer's container; never use page-wide submit buttons.
    const scope = form.closest('#js-answerAddCard, #AnswerFormPortalContainer') || form;
    if (scope !== form && Array.from(scope.querySelectorAll('form.AnswerForm')).filter(visible).length !== 1) return { ...base, status: 'ambiguous' };
    const labels = Array.from(scope.querySelectorAll('button')).filter(visible).map(b => clean(b.textContent));
    const mode = labels.includes('提交修改') ? 'edit' : labels.includes('发布回答') ? 'new' : '';
    if (!mode) return { ...base, status: 'page' };
    const blocks = Array.from(editor.querySelectorAll('[data-block="true"]'));
    const text = clean(blocks.length ? blocks.map(b => b.textContent).join('\n') : editor.innerText || editor.textContent);
    const tip = scope.querySelector('.DraftStatusTip');
    const saved = !!tip && !!tip.querySelector('.ZDI--CloudCheck24') && !/保存中|失败/.test(tip.textContent);
    return { ...base, status: 'editor', mode, text, saved,
        saveText: clean(tip?.textContent),
        hasRichContent: !!editor.querySelector('img, video, audio, iframe, table, pre') || blocks.some(b => b.className && !b.classList.contains('Editable-unstyled')),
        canSaveAndLeave: labels.includes('保存草稿并离开'),
    };
}

export function clickDraftControl(questionId, action) {
    if (location.origin !== 'https://www.zhihu.com' || !new RegExp('^/question/' + questionId + '(?:/answer/\\d+)?/?$').test(location.pathname)) return false;
    const clean = text => String(text || '').replace(/[\u200b\ufeff]/g, '').trim();
    const visible = node => {
        for (let n = node; n; n = n.parentElement) {
            if (n.hidden || n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden') return false;
        }
        return true;
    };
    const allowed = action === 'save' ? ['保存草稿并离开'] : action === 'open' ? ['编辑回答', '写回答'] : [];
    let scope = document;
    if (action === 'save') {
        const forms = Array.from(document.querySelectorAll('form.AnswerForm')).filter(visible);
        if (forms.length !== 1) return false;
        scope = forms[0].closest('#js-answerAddCard, #AnswerFormPortalContainer') || forms[0];
    }
    const matches = Array.from(scope.querySelectorAll('button')).filter(b => allowed.includes(clean(b.textContent)) && !b.disabled && visible(b));
    // Multiple identical header open controls are harmless; save must be unique.
    if (action === 'save' && matches.length !== 1) return false;
    const button = matches[0];
    if (!button) return false;
    button.click();
    return true;
}

export function prepareDraftInsertion(questionId, expectedText, position) {
    if (location.origin !== 'https://www.zhihu.com' || !new RegExp('^/question/' + questionId + '(?:/answer/\\d+)?/?$').test(location.pathname)) return { ok: false, reason: 'wrong_target' };
    const visible = node => {
        for (let n = node; n; n = n.parentElement) {
            if (n.hidden || n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden') return false;
        }
        return true;
    };
    const editors = Array.from(document.querySelectorAll('form.AnswerForm .public-DraftEditor-content[contenteditable="true"]')).filter(visible);
    if (editors.length !== 1) return { ok: false, reason: 'ambiguous_editor' };
    const editor = editors[0];
    const clean = text => String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
    const blocks = Array.from(editor.querySelectorAll('[data-block="true"]'));
    const current = clean(blocks.length ? blocks.map(b => b.textContent).join('\n') : editor.innerText || editor.textContent);
    if (current !== clean(expectedText)) return { ok: false, reason: 'content_changed' };
    if (!['replace', 'append', 'prepend'].includes(position)) return { ok: false, reason: 'invalid_position' };
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (position !== 'replace') range.collapse(position === 'prepend');
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true };
}

export function draftScript(fn, ...args) {
    return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`;
}
