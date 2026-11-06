// Redesign R4: the dashboard's design rules at the CSS level.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const css = readFileSync(new URL('dashboard.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}

describe('dashboard rows borrow the product row\'s visual language', () => {
  it('card rows use the shared row floor (never a fixed height) and the same surface, border and radius', () => {
    const body = rule('.dashboard__row--card');
    expect(body).toMatch(/min-height:\s*var\(--row-height-min\)/);
    expect(body).not.toMatch(/(?<![\w-])(?:height|max-height)\s*:/);
    expect(body).toMatch(/background:\s*var\(--color-surface\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
  });

  it('the quantity is the dominant figure: quantity token, tabular, bold', () => {
    const body = rule('.dashboard__qty');
    expect(body).toMatch(/font-size:\s*var\(--font-size-quantity\)/);
    expect(body).toMatch(/font-variant-numeric:\s*var\(--font-numeric\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-bold\)/);
  });

  it('the badge look is not redeclared here (the shared .badge draws it)', () => {
    expect(css).not.toMatch(/\.badge/);
  });
});

describe('attention row line', () => {
  it('puts the status on the left and Add stock on the far end, wrapping rather than overflowing', () => {
    const body = rule('.dashboard__row-line');
    expect(body).toMatch(/justify-content:\s*space-between/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('header and totals', () => {
  it('the header keeps the title and Add Product together and wraps on narrow screens', () => {
    const body = rule('.dashboard__header');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/justify-content:\s*space-between/);
  });

  it('the totals are a quiet register (label left, figure right), not a grid of cards', () => {
    // Scoped to the totals rules, so an unrelated dashboard rule may use a grid later.
    for (const selector of ['.dashboard__stats', '.dashboard__stats > div']) {
      expect(rule(selector)).not.toMatch(/display:\s*(?:inline-)?grid|grid-template/);
    }
    expect(rule('.dashboard__stats > div')).toMatch(/justify-content:\s*space-between/);
  });

  it('with enlarged text, label and figure wrap instead of overflowing, and the figure stays at the end', () => {
    expect(rule('.dashboard__stats > div')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.dashboard__stats dd')).toMatch(/margin:\s*0 0 0 auto/);
  });

  it('the quantity and badge may wrap as a pair at the card edge, never wider than the card', () => {
    const body = rule('.dashboard__row-detail--nowrap');
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/white-space:\s*nowrap/);
  });
});
