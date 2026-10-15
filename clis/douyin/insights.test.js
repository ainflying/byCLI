import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRegistry } from '@sovovs/bycli/registry';
describe('douyin insights', () => {
    it('reads a JSONL file locally without a browser or remote service', async () => {
        await import('./insights.js').catch(() => {});
        const command = [...getRegistry().values()].find(c => c.site === 'douyin' && c.name === 'insights');
        expect(command).toBeDefined();
        const dir = await mkdtemp(join(tmpdir(), 'bycli-insights-'));
        try {
            const path = join(dir, 'evidence.jsonl');
            await writeFile(path, '{"aweme_id":"123","title":"#topic","statistics":{"digg_count":4}}\n');
            const [result] = await command.func({ input: path });
            expect(command.browser).toBe(false);
            expect(result.sample.work_count).toBe(1);
            expect(result.ranking[0].score).toBe(4);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
