// Phase 7I Slice A: the shared primary-action button contract, at the CSS level.
//
// jsdom performs no layout or cascade, so this pins the rules (and the removal
// of the three former one-off primary styles) rather than rendered colors.
// Rendered appearance is verified in a real browser.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const base = read('base.css');

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `rule "${selector}"`).not.toBeNull();
  return match[1];
}

describe('.primary-action (shared primary button)', () => {
  it('uses the primary tokens for background, text and border, with semibold weight', () => {
    const body = rule(base, '.primary-action');
    expect(body).toMatch(/background:\s*var\(--color-primary\)/);
    expect(body).toMatch(/color:\s*var\(--color-on-primary\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-primary\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
  });

  it('has hover and active states that skip disabled and aria-disabled buttons', () => {
    const hover = rule(base, ".primary-action:hover:not(:disabled):not([aria-disabled='true'])");
    const active = rule(base, ".primary-action:active:not(:disabled):not([aria-disabled='true'])");
    expect(hover).toMatch(/background:\s*var\(--color-primary-hover\)/);
    expect(active).toMatch(/background:\s*var\(--color-primary-active\)/);
  });

  it('does not size the button itself: height and touch target come from the base button rule', () => {
    const body = rule(base, '.primary-action');
    expect(body).not.toMatch(/min-height|height|padding/);
  });

  it('the three former one-off primary styles are gone, so the declarations exist in one place', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const css = read(name);
      expect(css, name).not.toMatch(/\.login__submit|\.product-form__submit|\.app-error__reload/);
    }
    // The core primary-button background is declared only by the shared
    // classes (.primary-action and the link variant) and the token file.
    const files = readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'tokens.css');
    const users = files.filter((f) => /background:\s*var\(--color-primary\);/.test(read(f)));
    expect(users.sort()).toEqual(['base.css', 'shell.css']); // .primary-action, .primary-action-link
  });
});
