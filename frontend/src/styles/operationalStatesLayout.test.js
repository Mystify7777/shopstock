// Redesign R9a: the shared rules for ResourceView's states, the not-found state
// and the .quiet-link primitive, at the CSS level, plus (R9b) the crash
// fallback's card. Each assertion is scoped to the selector whose invariant it
// protects. The auth loading screen (frozen) is not asserted here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (name) => strip(readFileSync(new URL(name, dir), 'utf8'));
const base = read('base.css');
const shell = read('shell.css');
const dashboard = read('dashboard.css');

const rulesOf = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map((s) => s.trim()),
    body,
  }));
function rule(css, selector) {
  const found = rulesOf(css).find((r) => r.selectors.includes(selector));
  expect(found, `rule "${selector}"`).toBeDefined();
  return found.body;
}
const APPEARANCE = /(?<![\w-])(?:background|border|border-color|border-radius|box-shadow|padding|color|font-size|font-weight)\s*:/;

describe('.quiet-link: the link counterpart of .quiet-action', () => {
  it('is text only: the quiet color, a transparent 1px border and the control radius', () => {
    const body = rule(base, '.quiet-link');
    expect(body).toMatch(/color:\s*var\(--color-primary-active\)/);
    expect(body).toMatch(/border:\s*1px solid transparent/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-control\)/);
    expect(body).toMatch(/text-decoration:\s*none/);
    expect(body).not.toMatch(/background\s*:/);
  });
  it('does not size itself: the 44px target comes from .touch-link, as for .primary-action-link', () => {
    expect(rule(base, '.quiet-link')).not.toMatch(/(?<![\w-])(?:min-height|max-height|height|width|min-width)\s*:/);
  });
  it('its hover and press backgrounds are the ones its text contrast is checked against (same pairing as .quiet-action)', () => {
    expect(rule(base, '.quiet-link:hover')).toMatch(/background:\s*var\(--color-surface-hover\)/);
    expect(rule(base, '.quiet-link:active')).toMatch(/background:\s*var\(--color-surface-active\)/);
    expect(rule(base, '.quiet-link:hover')).toMatch(/color:\s*var\(--color-primary-active\)/);
  });
  it('is defined once, in base.css', () => {
    expect(rulesOf(shell).some((r) => r.selectors.includes('.quiet-link'))).toBe(false);
    expect(rulesOf(dashboard).some((r) => r.selectors.includes('.quiet-link'))).toBe(false);
  });
});

describe('.touch-link + .quiet-link: the combined recovery link keeps its 44px target', () => {
  // jsdom does no layout, so this pins the rules that produce the size. The
  // rendered size itself (>= 44px high at 320/375/768/1280, landscape and 200%
  // text) is verified in a real browser, not here.
  const props = (body) => new Set([...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]));
  it('.quiet-link and .touch-link declare no property in common, so source order cannot let one shrink the other', () => {
    const quiet = props(rule(base, '.quiet-link'));
    const touch = props(rule(base, '.touch-link'));
    expect([...quiet].filter((name) => touch.has(name))).toEqual([]);
  });
  it('.touch-link supplies the box and the minimum size; the token is 44px at the default text size', () => {
    const body = rule(base, '.touch-link');
    expect(body).toMatch(/display:\s*inline-flex/);
    expect(body).toMatch(/min-height:\s*var\(--touch-target-min\)/);
    expect(body).toMatch(/min-width:\s*var\(--touch-target-min\)/);
    expect(read('tokens.css')).toMatch(/--touch-target-min:\s*2\.75rem\s*;/);
  });
  it('.quiet-link adds only horizontal padding, so it cannot change the height', () => {
    expect(rule(base, '.quiet-link')).toMatch(/padding:\s*0 var\(--space-3\)/);
  });
});

describe('ResourceView', () => {
  it('a loading section is secondary-colored text with no margin of its own, not a box', () => {
    const body = rule(base, '.resource-view-loading');
    expect(body).toMatch(/color:\s*var\(--color-text-secondary\)/);
    expect(body).toMatch(/margin:\s*0/);
    expect(body).not.toMatch(/background|border|padding/);
  });
  it('a failed section only stacks its messages: the shared notice draws the look', () => {
    const body = rule(base, '.resource-view-error p');
    expect(body).toMatch(/margin:\s*0 0 var\(--space-2\)/);
    expect(body).not.toMatch(APPEARANCE);
  });
});

describe('not found', () => {
  it('the notice is only spaced from the link; its look is the shared notice', () => {
    const body = rule(shell, '.not-found-state .notice');
    expect(body).toMatch(/margin:\s*0 0 var\(--space-3\)/);
    expect(body).not.toMatch(APPEARANCE);
  });
  it('the old paragraph rule is gone', () => {
    expect(shell).not.toMatch(/\.not-found-state p\b/);
  });
});

describe('crash fallback (R9b)', () => {
  const card = rule(shell, '.app-error__card');
  it('the card is flat: the plain surface and a border, with no shadow and no elevated fill', () => {
    expect(card).toMatch(/background:\s*var\(--color-surface\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(card).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(card).not.toMatch(/box-shadow|--shadow|surface-elevated/);
  });
  it('matches the flat Login card, so the two full-screen cards look the same', () => {
    const login = rule(shell, '.login__card');
    for (const decl of ['background', 'border', 'border-radius']) {
      expect(card.match(new RegExp(`${decl}:[^;]*;`))[0]).toBe(login.match(new RegExp(`${decl}:[^;]*;`))[0]);
    }
  });
  it('the old hand-rolled link rule is gone: the 44px target is .touch-link, the look is .quiet-link', () => {
    expect(rulesOf(shell).some((r) => r.selectors.includes('.app-error__home'))).toBe(false);
  });
  it('large text on a narrow screen cannot push the card off screen: the heading and both actions may wrap', () => {
    expect(rule(shell, '.app-error__card h1')).toMatch(/overflow-wrap:\s*anywhere/);
    const actions = rule(shell, '.app-error__actions > *');
    expect(actions).toMatch(/max-width:\s*100%/);
    expect(actions).toMatch(/overflow-wrap:\s*anywhere/);
    expect(actions).not.toMatch(/(?<![\w-])(?:min-height|height|min-width|width)\s*:/); // never shrink the 44px target
  });
  it('the full-height .app-error rule is untouched (viewportClearance.test.js pins it)', () => {
    expect(rule(shell, '.app-error')).toMatch(/min-height:\s*100dvh/);
  });
});

describe('what R9a deliberately leaves in place', () => {
  it('the product list still styles its own failure block with .resource-error (it is not a ResourceView)', () => {
    const body = rule(dashboard, '.resource-error');
    expect(body).toMatch(/border|background/);
  });
  it('the auth loading screen keeps its shared full-height rule with the login (R7b pinned it)', () => {
    expect(rulesOf(shell).some((r) => r.selectors.includes('.auth-screen') && r.selectors.includes('.login'))).toBe(true);
  });
});
