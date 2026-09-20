import { AuthRequiredError, CliError, CommandExecutionError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolvePayload } from './write-shared.js';
import { resolveDraftOptions, normalizeDraftText, planDraftContent, inspectDraftPage, clickDraftControl, prepareDraftInsertion, draftScript } from './draft-shared.js';

async function inspect(page, options) {
    const state = await page.evaluate(draftScript(inspectDraftPage, options.questionId));
    if (state?.status === 'auth') throw new AuthRequiredError('www.zhihu.com', 'Log into Zhihu before saving an answer draft');
    if (state?.status === 'wrong_target' || (options.answerId && state?.answerId && state.answerId !== options.answerId)) {
        throw new CliError('TARGET_MISMATCH', 'Browser is not on the requested Zhihu question or answer');
    }
    if (state?.status === 'deleted') throw new CliError('ACTION_NOT_AVAILABLE', 'Your answer is deleted; Zhihu only offers undo deletion', 'Choose another question, or manage the deleted answer manually in Zhihu');
    if (state?.status === 'ambiguous') throw new CliError('ACTION_NOT_AVAILABLE', 'Multiple answer editors are visible');
    if (options.expectedTitle && state?.title && state.title !== options.expectedTitle) {
        throw new CliError('TARGET_MISMATCH', 'Question title does not match --expected-title');
    }
    return state;
}

async function openEditor(page, options) {
    const opened = new Set();
    let previous = '';
    for (let attempt = 0; attempt < options.timeout * 2 && Date.now() <= options.deadline; attempt++) {
        const state = await inspect(page, options);
        if (state?.status === 'editor' && state.title) {
            if ((options.mode !== 'auto' && state.mode !== options.mode) || (options.answerId && state.mode !== 'edit')) {
                throw new CliError('ACTION_NOT_AVAILABLE', `Requested mode ${options.mode} does not match the ${state.mode} answer editor`);
            }
            // Let the editor hydrate before reading or changing its old content.
            const signature = JSON.stringify([state.url, state.mode, state.text, state.hasRichContent]);
            if (signature === previous) return state;
            previous = signature;
        } else if (state?.ownAnswerUrl) {
            if (options.mode === 'new') throw new CliError('ACTION_NOT_AVAILABLE', 'You already have an answer to this question; use --mode edit or auto');
            if (!opened.has(state.ownAnswerUrl)) {
                opened.add(state.ownAnswerUrl);
                await page.goto(`${state.ownAnswerUrl}#write`);
            }
        } else if (state?.status === 'page' && !opened.has(state.url)) {
            if (await page.evaluate(draftScript(clickDraftControl, options.questionId, 'open'))) opened.add(state.url);
        }
        await page.wait(0.5);
    }
    throw new CliError('ACTION_NOT_AVAILABLE', 'Could not open a stable Zhihu answer editor', 'Open the question in Chrome and check the answer editor, or increase --timeout');
}

async function waitSaved(page, options, expected) {
    for (let attempt = 0; attempt < options.timeout * 2 && Date.now() <= options.deadline; attempt++) {
        const state = await inspect(page, options);
        if (state?.status === 'editor' && normalizeDraftText(state.text) === normalizeDraftText(expected) && state.saved) return state;
        await page.wait(0.5);
    }
    throw new CliError('DRAFT_SAVE_TIMEOUT', 'Could not confirm that Zhihu saved the complete draft', 'Inspect the editor before retrying; some content may already have been saved');
}

cli({
    site: 'zhihu', name: 'answer-waiting-draft', access: 'write',
    description: '保存知乎回答草稿（新回答或已有回答的编辑草稿，不发布）',
    domain: 'www.zhihu.com', strategy: Strategy.COOKIE,
    browser: kwargs => !resolveDraftOptions(kwargs).dryRun, navigateBefore: false,
    validateArgs: kwargs => {
        const options = resolveDraftOptions(kwargs);
        if (!options.execute && !options.dryRun) throw new CliError('INVALID_INPUT', 'Use --execute to save a draft or --dry-run to preview');
    },
    args: [
        { name: 'target', positional: true, required: true, help: 'Question ID, question/own-answer URL, question:<id>, or answer:<questionId>:<answerId>' },
        { name: 'text', positional: true, help: 'Plain-text answer body; use either text or --file' },
        { name: 'file', help: 'UTF-8 text file containing the answer body' },
        { name: 'mode', default: 'auto', choices: ['auto', 'new', 'edit'], help: 'auto detects new/edit; new refuses an existing answer; edit requires your existing answer' },
        { name: 'existing', default: 'error', choices: ['error', 'replace', 'append', 'prepend'], help: 'Policy when the editor already has content; identical text is left unchanged' },
        { name: 'separator', default: '\n\n', help: 'Literal separator for append/prepend (default: a blank line)' },
        { name: 'prefix', help: 'Literal text before the supplied body (include any desired newline)' },
        { name: 'suffix', help: 'Literal text after the supplied body (include any desired newline)' },
        { name: 'expected-title', help: 'Require an exact question title before editing' },
        { name: 'timeout', type: 'int', default: 30, help: 'Total editor/save verification wait budget in seconds (1–120)' },
        { name: 'close-editor', type: 'boolean', default: true, help: 'Close editor after verified save; false leaves it open (combine with --keep-tab true)' },
        { name: 'dry-run', type: 'boolean', help: 'Preview resolved input locally without opening or modifying the editor' },
        { name: 'execute', type: 'boolean', help: 'Actually save the draft; never publishes an answer' },
    ],
    columns: ['status', 'outcome', 'question_id', 'answer_id', 'mode', 'url', 'characters', 'verified', 'published', 'editor_open', 'message'],
    func: async (page, kwargs) => {
        const options = resolveDraftOptions(kwargs);
        if (!options.execute && !options.dryRun) throw new CliError('INVALID_INPUT', 'Use --execute to save a draft or --dry-run to preview');
        const body = await resolvePayload(kwargs);
        const payload = normalizeDraftText(options.prefix + body + options.suffix);
        if (!payload || payload.length > 50000) throw new CliError('INVALID_INPUT', 'Draft content must contain 1–50000 characters, including prefix and suffix');
        if (options.dryRun) return [{ status: 'preview', outcome: 'preview', question_id: options.questionId,
            answer_id: options.answerId, mode: options.mode, url: `${options.url}#write`, characters: [...payload].length,
            verified: false, published: false, editor_open: false, message: 'Local input preview; existing browser content has not been inspected',
            content: payload, existing: options.existing, separator: options.separator }];
        if (!page || typeof page.insertText !== 'function') throw new CommandExecutionError('Browser session with native text insertion is required for zhihu answer-waiting-draft');
        options.deadline = Date.now() + options.timeout * 1000;
        await page.goto(`${options.url}#write`);
        const initial = await openEditor(page, options);
        if (initial.hasRichContent && !initial.text && options.existing === 'error') throw new CliError('DRAFT_EXISTS', 'The editor contains rich content', 'Choose --existing replace, append, or prepend');
        const plan = planDraftContent(initial.text, payload, options.existing, options.separator, initial.hasRichContent);
        if (plan.expected.length > 50000) throw new CliError('INVALID_INPUT', 'Combined draft content exceeds 50000 characters');
        if (plan.changed) {
            const prepared = await page.evaluate(draftScript(prepareDraftInsertion, options.questionId, initial.text, plan.position));
            if (!prepared?.ok) throw new CliError('DRAFT_CONFLICT', `Could not prepare the editor: ${prepared?.reason || 'unknown state'}`, 'Inspect the draft before retrying');
            // Native input updates Draft.js state. Do not assign innerHTML/textContent.
            await page.insertText(plan.insertion);
        }
        const saved = await waitSaved(page, options, plan.expected);
        if (saved.canSaveAndLeave) await page.evaluate(draftScript(clickDraftControl, options.questionId, 'save'));
        // Reload from Zhihu and reopen: a local DOM update or stale save badge is
        // insufficient evidence of a persisted draft.
        const draftUrl = saved.url.split('#')[0];
        await page.goto('about:blank');
        await page.goto(`${draftUrl}#write`);
        const restored = await openEditor(page, options);
        if (normalizeDraftText(restored.text) !== normalizeDraftText(plan.expected) || restored.mode !== initial.mode || !restored.saved) {
            throw new CliError('DRAFT_VERIFY_FAILED', 'Reloaded draft does not match the requested content', 'Inspect the existing draft before retrying; no answer was published');
        }
        let editorOpen = true;
        if (options.closeEditor) {
            const closed = await page.evaluate(draftScript(clickDraftControl, options.questionId, 'save'));
            if (!closed) await page.goto(draftUrl);
            const final = await inspect(page, options);
            editorOpen = final?.status === 'editor';
        }
        return [{ status: 'success', outcome: plan.changed ? 'saved' : 'unchanged', question_id: options.questionId,
            answer_id: restored.answerId || '', mode: restored.mode, url: `${draftUrl}#write`, characters: [...normalizeDraftText(plan.expected)].length,
            verified: true, published: false, editor_open: editorOpen,
            message: restored.mode === 'edit' ? 'Existing answer’s edit draft saved and verified; changes not submitted' : 'New answer draft saved and verified; answer not published' }];
    },
});
