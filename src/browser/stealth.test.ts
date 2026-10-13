import { createContext, runInContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { generateStealthJs } from './stealth.js';

/**
 * Tests for the stealth anti-detection module.
 *
 * We test the generated JS string for expected content and structure.
 * Browser-only patches retain structural checks. Eval compatibility is
 * exercised with the real generated script in an isolated JavaScript context.
 */

describe('generateStealthJs', () => {
  it('returns a non-empty string', () => {
    const code = generateStealthJs();
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });

  it('is a valid self-contained IIFE', () => {
    const code = generateStealthJs();
    // Should start/end as an IIFE
    expect(code.trim()).toMatch(/^\(\(\) => \{/);
    expect(code.trim()).toMatch(/\}\)\(\)$/);
  });

  it('patches navigator.webdriver', () => {
    const code = generateStealthJs();
    expect(code).toContain("navigator, 'webdriver'");
    expect(code).toContain('() => false');
  });

  it('stubs window.chrome', () => {
    const code = generateStealthJs();
    expect(code).toContain('window.chrome');
    expect(code).toContain('runtime');
    expect(code).toContain('loadTimes');
    expect(code).toContain('csi');
  });

  it('fakes navigator.plugins if empty', () => {
    const code = generateStealthJs();
    expect(code).toContain('navigator.plugins');
    expect(code).toContain('PDF Viewer');
    expect(code).toContain('Chrome PDF Viewer');
  });

  it('ensures navigator.languages is non-empty', () => {
    const code = generateStealthJs();
    expect(code).toContain('navigator.languages');
    expect(code).toContain("'en-US'");
  });

  it('normalizes Permissions.query for notifications', () => {
    const code = generateStealthJs();
    expect(code).toContain('Permissions');
    expect(code).toContain('notifications');
  });

  it('cleans automation artifacts', () => {
    const code = generateStealthJs();
    expect(code).toContain('__playwright');
    expect(code).toContain('__puppeteer');
    expect(code).toContain("'cdc_'");
    expect(code).toContain("'__cdc_'");
  });

  it('filters CDP patterns from Error.stack', () => {
    const code = generateStealthJs();
    expect(code).toContain('puppeteer_evaluation_script');
    expect(code).toContain("'pptr:'");
    expect(code).toContain("'debugger://'");
  });

  it('neutralizes debugger statements in dynamic Function bodies', () => {
    const code = generateStealthJs();
    // Should patch Function constructor with new.target / Reflect.construct
    expect(code).toContain('_OrigFunction');
    expect(code).toContain('_PatchedFunction');
    expect(code).toContain('new.target');
    expect(code).toContain('Reflect.construct');
    // Regex to strip debugger (lookbehind for statement boundaries)
    expect(code).toContain('_debuggerRe');
  });

  it('uses shared toString disguise via WeakMap', () => {
    const code = generateStealthJs();
    // Shared infrastructure at the top of the IIFE
    expect(code).toContain('_origToString');
    expect(code).toContain('WeakMap');
    expect(code).toContain('_disguised');
    expect(code).toContain('_disguise');
    // Should NOT have per-instance toString overrides on Function
    // (they go through _disguise instead)
  });

  it('defends console method fingerprinting', () => {
    const code = generateStealthJs();
    expect(code).toContain('_consoleMethods');
    expect(code).toContain("'log'");
    expect(code).toContain("'warn'");
    expect(code).toContain("'error'");
    expect(code).toContain('[native code]');
    // Uses saved _origToString reference
    expect(code).toContain('_origToString.call');
  });

  it('defends window dimension detection', () => {
    const code = generateStealthJs();
    expect(code).toContain('outerWidth');
    expect(code).toContain('outerHeight');
    expect(code).toContain('innerWidth');
    expect(code).toContain('innerHeight');
  });

  it('filters Performance API entries', () => {
    const code = generateStealthJs();
    expect(code).toContain('getEntries');
    expect(code).toContain('getEntriesByType');
    expect(code).toContain('getEntriesByName');
    expect(code).toContain('_suspiciousPatterns');
  });

  it('cleans document $cdc_ properties', () => {
    const code = generateStealthJs();
    expect(code).toContain("'$cdc_'");
    expect(code).toContain("'$chrome_'");
  });

  it('patches iframe contentWindow.chrome consistency', () => {
    const code = generateStealthJs();
    expect(code).toContain('contentWindow');
    expect(code).toContain('HTMLIFrameElement');
  });

  it('uses non-enumerable guard flag on EventTarget.prototype', () => {
    const code = generateStealthJs();
    expect(code).toContain('EventTarget.prototype');
    expect(code).toContain("'__lsn'");
    expect(code).toContain('enumerable: false');
  });

  it('generates syntactically valid JavaScript', () => {
    const code = generateStealthJs();
    // new Function() parses the code without executing it in a real
    // browser context, catching syntax errors from template literal issues.
    expect(() => new Function(code)).not.toThrow();
  });
});

/** Catch regressions that replace native eval and lose the caller's scope. */
describe('stealth eval compatibility', () => {
  function injectStealth() {
    const context = createContext({});
    runInContext(`
      globalThis.window = globalThis;
      globalThis.EventTarget = class EventTarget {};
      globalThis.navigator = {};
      globalThis.document = {};
    `, context);
    runInContext(generateStealthJs(), context);
    return context;
  }

  it('preserves direct eval reads from the caller lexical scope', () => {
    const context = injectStealth();
    expect(runInContext(`(() => {
      const localValue = 37;
      return eval('localValue');
    })()`, context)).toBe(37);
  });

  it('preserves direct eval writes without creating a global variable', () => {
    const context = injectStealth();
    expect(runInContext(`(() => {
      let localValue = 1;
      eval('localValue = 9');
      return localValue;
    })()`, context)).toBe(9);
    expect(runInContext("'localValue' in globalThis", context)).toBe(false);
  });

  it('preserves strict caller scope when reading local variables', () => {
    const context = injectStealth();
    expect(runInContext(`(() => {
      'use strict';
      const localValue = 42;
      return eval('localValue');
    })()`, context)).toBe(42);
  });

  it('keeps strict eval declarations out of the global scope', () => {
    const context = injectStealth();
    expect(runInContext(`(() => {
      'use strict';
      eval('var strictTemporary = 1');
      return typeof strictTemporary;
    })()`, context)).toBe('undefined');
    expect(runInContext("'strictTemporary' in globalThis", context)).toBe(false);
  });

  it('keeps native eval non-string input and thrown exceptions', () => {
    const context = injectStealth();
    expect(runInContext('eval(17)', context)).toBe(17);
    expect(runInContext(`(() => {
      try { eval('throw new Error("probe-error")'); }
      catch (error) { return error.message; }
    })()`, context)).toBe('probe-error');
  });

  it('preserves eval semantics after repeated stealth injection', () => {
    const context = injectStealth();
    runInContext(generateStealthJs(), context);
    expect(runInContext(`(() => {
      const localValue = 37;
      return eval('localValue');
    })()`, context)).toBe(37);
  });

  it('still strips debugger statements from dynamic Function bodies', () => {
    const context = injectStealth();
    const result = runInContext(`(() => {
      const fn = new Function('debugger; return 7;');
      return { result: fn(), body: fn.toString() };
    })()`, context);
    expect(result.result).toBe(7);
    expect(result.body).not.toContain('debugger;');
  });
});
