// Redesign R5: the Product List's layout invariants, at the CSS level. Each
// assertion is scoped to the selector whose rule it protects, so an unrelated
// future rule in products.css cannot trip it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const css = readFileSync(new URL('products.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}
// Any declaration that constrains an element's own width, whatever the value or unit.
const WIDTH_CONSTRAINT = /(?<![\w-])(?:width|min-width|max-width|flex-basis)\s*:/;

describe('search', () => {
  it('the field takes all the width the row has, and can shrink below its content', () => {
    const body = rule('.product-list__search-row input');
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-width:\s*0/);
  });
  it('no orphaned label rule is left to out-specify the visually hidden label', () => {
    expect(css).not.toMatch(/\.product-list__search\s+label/);
  });
});

describe('filter disclosure', () => {
  it('hides the collapsed panel even though its own display value is flex', () => {
    expect(rule('.product-list__filters-panel')).toMatch(/display:\s*flex/);
    expect(rule('.product-list__filters-panel[hidden]')).toMatch(/display:\s*none/);
  });
  it('shows open or closed with an arrow as well as aria-expanded, never color alone', () => {
    expect(rule('.filters-toggle::after')).toMatch(/content:/);
    expect(rule(".filters-toggle[aria-expanded='true']::after")).toMatch(/content:/);
  });
  it('the count is the same selected look as a checked filter chip', () => {
    const body = rule('.filters-toggle__count');
    expect(body).toMatch(/background:\s*var\(--color-selected-bg\)/);
    expect(body).toMatch(/color:\s*var\(--color-selected-fg\)/);
  });
});

describe('active filter chips', () => {
  it('the strip and the chips wrap instead of overflowing', () => {
    expect(rule('.product-list__active')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.product-list__chips')).toMatch(/flex-wrap:\s*wrap/);
  });
  it('a long label wraps inside its chip and the chip never exceeds its container', () => {
    expect(rule('.filter-chip')).toMatch(/max-width:\s*100%/);
    const label = rule('.filter-chip__label');
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('the chip does not size itself: its 44px height comes from the base button rule', () => {
    expect(rule('.filter-chip')).not.toMatch(/(?<![\w-])(?:min-height|max-height|height)\s*:/);
  });
  it('uses the selected tokens, so its contrast is the one tokens.test.js already checks', () => {
    const body = rule('.filter-chip');
    expect(body).toMatch(/background:\s*var\(--color-selected-bg\)/);
    expect(body).toMatch(/color:\s*var\(--color-selected-fg\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-selected-border\)/);
  });
  it('keeps the selected background on hover and press, so text contrast cannot change', () => {
    for (const state of ['hover', 'active']) {
      const body = rule(`.filter-chip:${state}:not(:disabled):not([aria-disabled='true'])`);
      expect(body).toMatch(/background:\s*var\(--color-selected-bg\)/);
    }
  });
});

describe('results list and filter area', () => {
  // Responsive containment: each is a column whose children stretch to the width
  // the page gives it, and neither constrains its own width in any way.
  it.each(['.product-list__results', '.product-list__filters'])(
    '%s is a flex column that stretches its children and sets no width of its own',
    (selector) => {
      const body = rule(selector);
      expect(body).toMatch(/display:\s*flex/);
      expect(body).toMatch(/flex-direction:\s*column/);
      expect(body).not.toMatch(WIDTH_CONSTRAINT);
      // Children stretch by default; anything that shrinks or centers them would not.
      expect(body).not.toMatch(/align-items:\s*(?!stretch\b)/);
    },
  );
  it('one status system: this stylesheet declares no .badge selector of its own', () => {
    expect(css).not.toMatch(/(?:^|[\s,}])\.badge(?:--[\w-]+)?\s*[,{]/m);
  });
});
