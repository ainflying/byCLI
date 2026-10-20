import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { requirePublishConfirmation } from './publish-confirmation.js';
import '../zhihu/article-publish.js';
import '../zhihu/video-publish.js';
import '../zhihu/answer-submit.js';
import '../weixin-channels/video-publish.js';
import '../baijiahao/video-publish.js';
import '../baijiahao/image-text-publish.js';
import '../baijiahao/article-publish.js';

describe('saved draft and user confirmation precede publication', () => {
  const commands = ['zhihu/article-publish', 'zhihu/video-publish', 'zhihu/answer-submit',
    'weixin-channels/video-publish', 'baijiahao/video-publish', 'baijiahao/image-text-publish', 'baijiahao/article-publish'];
  it.each(commands)('%s refuses unconfirmed submit before any browser action', async name => {
    const command = getRegistry().get(name);
    const args = { operation: '/nonexistent/operation.json', mode: 'submit', execute: true };
    expect(command.args.find(arg => arg.name === 'user-confirmed')).toMatchObject({ type: 'boolean' });
    expect(() => command.validateArgs(args)).toThrow('--user-confirmed');
    const page = { contextId: 'test', evaluate: vi.fn(), goto: vi.fn(), click: vi.fn() };
    await expect(command.func(page, args)).rejects.toThrow('--user-confirmed');
    expect(page.evaluate).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(page.click).not.toHaveBeenCalled();
  });
  it.each([undefined, false, 'true', 1])('only a literal boolean attestation is accepted: %s', flag => {
    expect(() => requirePublishConfirmation({ mode: 'submit', 'user-confirmed': flag })).toThrow();
  });
  it('does not allow preparation to pre-authorize a future submit', () => {
    expect(() => requirePublishConfirmation({ mode: 'prepare', 'user-confirmed': true })).toThrow('separate submit');
    expect(() => requirePublishConfirmation({ mode: 'submit', 'user-confirmed': true })).not.toThrow();
  });
});
