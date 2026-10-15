import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { browserFetch } from './browser-fetch.js';
function makePage(result) {
    return {
        goto: vi.fn(), evaluate: vi.fn().mockResolvedValue(result),
        getCookies: vi.fn(), snapshot: vi.fn(), click: vi.fn(),
        typeText: vi.fn(), pressKey: vi.fn(), scrollTo: vi.fn(),
        getFormState: vi.fn(), wait: vi.fn(), tabs: vi.fn(),
        networkRequests: vi.fn(), consoleMessages: vi.fn(),
        scroll: vi.fn(), autoScroll: vi.fn(),
        installInterceptor: vi.fn(), getInterceptedRequests: vi.fn(),
        screenshot: vi.fn(),
    };
}
describe('browserFetch', () => {
    it('returns parsed JSON on success', async () => {
        const page = makePage({ status_code: 0, data: { ak: 'KEY' } });
        const result = await browserFetch(page, 'GET', 'https://creator.douyin.com/api/test');
        expect(result).toEqual({ status_code: 0, data: { ak: 'KEY' } });
    });
    it('unwraps Browser Bridge {session,data} envelopes', async () => {
        const page = makePage({ session: 'site:douyin:test', data: { status_code: 0, data: { ok: true } } });
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test'))
            .resolves.toEqual({ status_code: 0, data: { ok: true } });
    });
    it('throws when status_code is non-zero', async () => {
        const page = makePage({ status_code: 8, message: 'fail' });
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test')).rejects.toThrow('Douyin API error 8');
    });
    it('maps auth-like API errors to AuthRequiredError', async () => {
        const page = makePage({ status_code: 401, status_msg: 'login required' });
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test'))
            .rejects.toBeInstanceOf(AuthRequiredError);
    });
    it('returns result even when no status_code field', async () => {
        const page = makePage({ some_field: 'value' });
        const result = await browserFetch(page, 'GET', 'https://creator.douyin.com/api/test');
        expect(result).toEqual({ some_field: 'value' });
    });
    it('throws on empty response body (null from evaluate)', async () => {
        const page = makePage(null);
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test')).rejects.toThrow('Empty response from Douyin API');
    });
    it('throws on undefined response body', async () => {
        const page = makePage(undefined);
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test')).rejects.toThrow('Empty response from Douyin API');
    });
    it('throws typed on malformed primitive response body', async () => {
        const page = makePage('not-json-object');
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test'))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });
    it('throws typed when browser fetch returns a non-JSON body', async () => {
        const page = makePage({ status_code: -2, status_msg: 'JSON parse failed: <html>not-json</html>' });
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test'))
            .rejects.toThrow('Douyin API error -2');
    });
    it('wraps browser-side fetch or JSON parse failures', async () => {
        const page = makePage(null);
        page.evaluate.mockRejectedValueOnce(new SyntaxError('Unexpected token < in JSON'));
        await expect(browserFetch(page, 'GET', 'https://creator.douyin.com/api/test')).rejects.toThrow('Douyin API request failed (GET https://creator.douyin.com/api/test): Unexpected token < in JSON');
    });
});

describe('browserFetch transport failures', () => {
    function transportPage(status, text) {
        return { evaluate: async js => vm.runInNewContext(js, {
            AbortController, setTimeout, clearTimeout,
            fetch: async () => ({ ok: status >= 200 && status < 300, status, text: async () => text }),
        }) };
    }
    it('rejects HTTP authentication failures even when their JSON status_code is zero', async () => {
        await expect(browserFetch(transportPage(403, '{"status_code":0}'), 'GET', 'https://www.douyin.com/api/test')).rejects.toBeInstanceOf(AuthRequiredError);
    });
    it('does not expose response bodies or sensitive request query parameters in errors', async () => {
        const error = await browserFetch(transportPage(500, '<html>private-cookie-value</html>'), 'GET', 'https://www.douyin.com/api/test?msToken=secret-value').catch(e => e);
        expect(error).toBeInstanceOf(CommandExecutionError);
        expect(error.message).not.toContain('private-cookie-value');
        expect(error.message).not.toContain('secret-value');
    });
});
