import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import './answer.js';
describe('legacy direct answer publishing is disabled', () => {
    it('rejects even --execute before browser access', async () => {
        const cmd = getRegistry().get('zhihu/answer');
        const args = { target: 'question:1', text: 'body', execute: true };
        expect(() => cmd.validateArgs(args)).toThrow('Direct answer publishing is disabled');
        const page = { goto: vi.fn(), evaluate: vi.fn() };
        await expect(cmd.func(page, args)).rejects.toThrow('save and verify a draft');
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });
});
