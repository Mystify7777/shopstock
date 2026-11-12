// Redesign R7b: the login card's design rules, at the CSS level. Scoped to the
// .login__* selectors: the shared ".auth-screen, .login" rule (R9's loading
// screen uses it too) is deliberately not asserted here and was left untouched.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const shell = readFileSync(new URL('shell.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const rules = [...shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.split(',').map((s) => s.trim()),
  body,
}));
function rule(selector) {
  const found = rules.find((r) => r.selectors.includes(selector));
  expect(found, `rule "${selector}"`).toBeDefined();
  return found.body;
}
// A real shadow: any box-shadow value except "none".
const SHADOW = /box-shadow\s*:\s*(?=\S)(?!none\b)/;
const APPEARANCE = /(?<![\w-])(?:background|border|border-color|border-radius|box-shadow|padding|color|font-size|font-weight)\s*:/;

describe('the card is flat and bordered', () => {
  it('has a border, the card radius and a plain surface fill, and no shadow or elevation', () => {
    const body = rule('.login__card');
    expect(body).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(body).toMatch(/background:\s*var\(--color-surface\)/);
    expect(body).not.toMatch(SHADOW);
    expect(body).not.toMatch(/surface-elevated/);
  });
  it('fills its column up to a maximum width', () => {
    const body = rule('.login__card');
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/max-width:/);
  });
  it('no .login rule uses a shadow', () => {
    for (const { selectors, body } of rules.filter((r) => r.selectors.some((s) => s.startsWith('.login')))) {
      expect(body, selectors.join(', ')).not.toMatch(SHADOW);
    }
  });
});

describe('messages', () => {
  it('the old .login__error look is gone (the shared notice draws it)', () => {
    expect(shell).not.toMatch(/\.login__error/);
  });
  it('the login only spaces the shared notice, and never redeclares its look', () => {
    const body = rule('.login .notice');
    expect(body).toMatch(/margin-bottom:/);
    expect(body).not.toMatch(APPEARANCE);
  });
  it('the line under the title is secondary text with room beneath it', () => {
    const body = rule('.login__intro');
    expect(body).toMatch(/color:\s*var\(--color-text-secondary\)/);
    expect(body).toMatch(/margin:\s*0 0 var\(--space-4\)/);
  });
});

describe('actions', () => {
  it('wrap, so a button never overflows the card', () => {
    expect(rule('.login__actions')).toMatch(/flex-wrap:\s*wrap/);
  });
  it('Sign in and the quiet button each take their own full-width line', () => {
    expect(rule('.login__actions .primary-action')).toMatch(/flex:\s*1 1 100%/);
    expect(rule('.login__actions .quiet-action')).toMatch(/flex:\s*1 1 100%/);
  });
  it('the buttons are not sized here: their 44px height comes from the base button rule', () => {
    expect(rule('.login__actions .primary-action')).not.toMatch(/(?<![\w-])(?:min-height|max-height|height)\s*:/);
  });
});

describe('what stays as it was', () => {
  it('the title may still break a long word, and fields still fill the card', () => {
    expect(rule('.login__card h1')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.login__field input')).toMatch(/width:\s*100%/);
  });
});
