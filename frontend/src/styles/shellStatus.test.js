// Redesign R2: shell status styling and the mobile nav active indicator, at the
// CSS level (jsdom does no layout; rendered results are checked in a browser).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const shell = strip(readFileSync(new URL('shell.css', dir), 'utf8'));
const base = strip(readFileSync(new URL('base.css', dir), 'utf8'));

function rule(source, selector) {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}

describe('.notice--neutral', () => {
  it('reuses the existing offline tokens, accent edge included', () => {
    const body = rule(base, '.notice--neutral');
    expect(body).toMatch(/background:\s*var\(--color-offline-bg\)/);
    expect(body).toMatch(/color:\s*var\(--color-offline-fg\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-offline-border\)/);
    expect(body).toMatch(/border-inline-start-color:\s*var\(--color-offline\)/);
  });
});

describe('sync status and session notice in the shell', () => {
  it('take their colors from the notice variants, not from shell rules', () => {
    for (const selector of ['.session-notice', '.sync-status']) {
      expect(rule(shell, selector)).not.toMatch(/background|(?<![\w-])color\s*:|border-color/);
    }
    expect(shell).not.toMatch(/\.sync-status--|\.session-notice--/);
  });

  it('align with the width and gutters of <main> instead of spanning the viewport', () => {
    const body = rule(shell, '.sync-status');
    expect(body).toMatch(/width:\s*calc\(100%\s*-\s*2\s*\*\s*var\(--gutter\)\)/);
    expect(body).toMatch(/max-width:\s*calc\(var\(--layout-width-content\)\s*-\s*2\s*\*\s*var\(--gutter\)\)/);
    expect(body).toMatch(/margin:[^;]*auto/);
  });

  it('are denser than the shared notice default, using spacing tokens (the shared .notice is untouched)', () => {
    const px = (v) => ({ '--space-1': 4, '--space-2': 8, '--space-3': 12 })[v];
    const pad = (body) => body.match(/padding:\s*var\((--space-\d)\)\s+var\((--space-\d)\)/).slice(1).map(px);
    const [shellBlock, shellInline] = pad(rule(shell, '.sync-status'));
    const [baseBlock, baseInline] = pad(rule(base, '.notice'));
    expect(shellBlock).toBeLessThan(baseBlock);
    expect(shellInline).toBeLessThanOrEqual(baseInline);
    expect(rule(base, '.notice')).toMatch(/padding:\s*var\(--space-2\)\s+var\(--space-3\)/);
  });

  it('are not styled as controls: no cursor and no hover or active state', () => {
    expect(shell).not.toMatch(/\.sync-status[^{}]*:(hover|active|focus)/);
    expect(rule(shell, '.sync-status')).not.toMatch(/cursor/);
  });
});

describe('primary navigation active indicator', () => {
  it('desktop keeps its existing bottom-edge indicator', () => {
    expect(rule(shell, ".primary-nav__link[aria-current='page']")).toMatch(
      /box-shadow:\s*inset 0 calc\(var\(--focus-ring-width\) \* -1\) 0/,
    );
  });

  it('on the mobile bar the indicator is on the top edge', () => {
    const body = rule(
      shell,
      ".primary-nav[data-mobile-bar='true'] .primary-nav__link[aria-current='page']",
    );
    expect(body).toMatch(/box-shadow:\s*inset 0 var\(--focus-ring-width\) 0 var\(--color-selected-border\)/);
  });

  it('the mobile bar height is unchanged: tabs are still control-height-lg', () => {
    const link = rule(shell, ".primary-nav[data-mobile-bar='true'] .primary-nav__link");
    expect(link).toMatch(/min-height:\s*var\(--control-height-lg\)/);
  });

  // R6 replaced the assumed bar height in the page's bottom padding with the
  // measured one (the bar can grow with text size), so this now pins that.
  it('the content clears the bar by its MEASURED height, not an assumed one', () => {
    const body = rule(shell, ".app-shell[data-has-bottom-bar='true'] .app-shell__main");
    expect(body).toMatch(/padding-bottom:\s*calc\(var\(--chrome-bottom\)\s*\+\s*var\(--stock-actions-height\)/);
    expect(body).not.toMatch(/control-height/);
  });
});
