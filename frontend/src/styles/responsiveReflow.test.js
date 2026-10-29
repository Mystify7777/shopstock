// Phase 7H D1/D2: navigation and login layout at 320px and with enlarged text, at the CSS level.
//
// jsdom performs no layout, so these cannot show that nothing overflows. They pin the
// rules that prevent it, so an edit cannot quietly reintroduce the overflow. The actual
// result was measured in a real browser (see tools/a11y-audit: `layout` and `fontsize`
// checks, which use the browser's real default font size).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const shell = strip(readFileSync(new URL('shell.css', dir), 'utf8'));

// Declarations of the first rule whose selector LIST contains `selector` (also inside @media),
// so a grouped rule such as ".auth-screen, .login" is found by either name.
function rule(source, selector) {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}

describe('bottom navigation bar fits at 320px and with enlarged text (D1)', () => {
  const tab = rule(shell, ".primary-nav[data-mobile-bar='true'] li");
  const link = rule(shell, ".primary-nav[data-mobile-bar='true'] .primary-nav__link");

  it('tabs share the bar by content and can shrink below their longest word', () => {
    expect(tab).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(tab).toMatch(/min-width:\s*0\s*;/); // without this a flex item cannot get narrower than its longest word
  });

  it('a label that does not fit wraps instead of being clipped', () => {
    expect(link).toMatch(/overflow-wrap:\s*anywhere/); // not break-word: only anywhere lowers the minimum size
    expect(link).toMatch(/text-align:\s*center/);
  });

  it('the old fixed equal-share rule is gone', () => {
    expect(tab).not.toMatch(/flex:\s*1\s*;/);
  });
});

describe('header does not push the brand or Sign out off screen (D1)', () => {
  it('the header row wraps', () => {
    expect(rule(shell, '.app-shell__header-inner')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('login card stays inside the screen with enlarged text (D2)', () => {
  it('the grid column is pinned to the available width, so a large heading cannot widen it', () => {
    // An implicit grid column is as wide as its widest unbreakable content.
    expect(rule(shell, '.login')).toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
  });

  it('a long heading word can never escape the card', () => {
    expect(rule(shell, '.login__card h1')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('no stylesheet puts a role on a list (D3 guard)', () => {
  // The same mistake can recur in markup: a role on <ul>/<ol> replaces the list semantics.
  it('no source file renders <ul role=...> or <ol role=...>', () => {
    const root = new URL('../', import.meta.url);
    const offenders = [];
    const walk = (url) => {
      for (const entry of readdirSync(url, { withFileTypes: true })) {
        const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, url);
        if (entry.isDirectory()) walk(child);
        else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          if (/<(ul|ol)\b[^>]*\brole=/.test(readFileSync(child, 'utf8'))) offenders.push(entry.name);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
