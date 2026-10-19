import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildFindJs, buildSemanticFindJs } from './find.js';
import { resolveTargetJs, clickResolvedJs } from './target-resolver.js';

describe('open shadow target identity', () => {
  function fixture() {
    const dom = new JSDOM('<button>outer</button><wujie-app></wujie-app><iframe></iframe>', { runScripts: 'outside-only' });
    const root = dom.window.document.querySelector('wujie-app')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="publish">发表</button><input type="file" accept="video/*"><nested-app></nested-app>';
    root.querySelector('nested-app')!.attachShadow({ mode: 'open' }).innerHTML = '<button>nested</button>';
    return { dom, root, run: (script: string) => dom.window.eval(script) as any };
  }
  it('uses the same CSS and numeric-ref identity for find, resolve and click', () => {
    const { dom, root, run } = fixture();
    const found = run(buildFindJs('#publish'));
    expect(found.matches_n).toBe(1);
    expect(run(resolveTargetJs(String(found.entries[0].ref)))).toMatchObject({ ok: true });
    const button = root.querySelector('button')!;
    button.scrollIntoView = () => {};
    let clicks = 0;
    button.addEventListener('click', () => clicks++);
    run(clickResolvedJs());
    expect(clicks).toBe(1);
    expect((dom.window as any).__resolved).toBe(button);
  });
  it('keeps uniqueness across light DOM and nested shadows, with explicit nth selection', () => {
    const { root, run } = fixture();
    expect(run(resolveTargetJs('button'))).toMatchObject({ code: 'selector_ambiguous', matches_n: 3 });
    expect(run(resolveTargetJs('button', { nth: 1 }))).toMatchObject({ ok: true, matches_n: 3 });
    expect(run(buildSemanticFindJs({ role: 'button', name: '发表' })).entries).toHaveLength(1);
    root.innerHTML += '<button id="publish">发表</button>';
    expect(run(resolveTargetJs('#publish'))).toMatchObject({ code: 'selector_ambiguous' });
  });
  it('does not cross iframe or closed shadow boundaries', () => {
    const { dom, run } = fixture();
    const host = dom.window.document.createElement('closed-app');
    dom.window.document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<input id="secret">';
    dom.window.document.querySelector('iframe')!.contentDocument!.body.innerHTML = '<input id="frame-input">';
    expect(run(resolveTargetJs('#secret'))).toMatchObject({ code: 'selector_not_found' });
    expect(run(resolveTargetJs('#frame-input'))).toMatchObject({ code: 'selector_not_found' });
  });
});
