// Redesign R3: the product row's design rules, at the CSS level (jsdom does no
// layout; the rendered result is checked in a real browser).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const products = strip(readFileSync(new URL('products.css', dir), 'utf8'));
const tokens = strip(readFileSync(new URL('tokens.css', dir), 'utf8'));

function rule(source, selector) {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}
const rem = (name) => {
  const m = tokens.match(new RegExp(`${name}:\\s*([\\d.]+)rem\\s*;`));
  expect(m, name).not.toBeNull();
  return parseFloat(m[1]);
};

describe('row height', () => {
  it('is a floor of at least 56px (3.5rem at the default size), never a fixed height', () => {
    expect(rem('--row-height-min')).toBeGreaterThanOrEqual(3.5);
    const body = rule(products, '.product-row__link');
    expect(body).toMatch(/min-height:\s*var\(--row-height-min\)/);
    expect(body).not.toMatch(/(?<![\w-])(?:height|max-height)\s*:/);
  });

  it('the whole row is the interactive target, so it exceeds the 44px touch minimum', () => {
    expect(rem('--row-height-min')).toBeGreaterThan(rem('--touch-target-min'));
  });
});

describe('quantity hierarchy', () => {
  const body = rule(products, '.product-row__quantity');
  it('uses the quantity token, tabular figures and a heavier weight than the name', () => {
    expect(body).toMatch(/font-size:\s*var\(--font-size-quantity\)/);
    expect(body).toMatch(/font-variant-numeric:\s*var\(--font-numeric\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-bold\)/);
    expect(rule(products, '.product-row__name')).toMatch(/font-weight:\s*var\(--font-weight-medium\)/);
  });
  it('is larger than any other text in the row (status badge is helper-size)', () => {
    expect(rem('--font-size-quantity')).toBeGreaterThan(rem('--font-size-body'));
    expect(rem('--font-size-quantity')).toBeGreaterThan(rem('--font-size-helper'));
  });
  it('is right-aligned so figures line up, and does not shrink', () => {
    expect(body).toMatch(/text-align:\s*end/);
    expect(body).toMatch(/flex:\s*none/);
  });
});

describe('long names and enlarged text', () => {
  it('the name takes the remaining width with a small basis and may shrink (ellipsis comes from .text-truncate)', () => {
    expect(rule(products, '.product-row__name')).toMatch(/flex:\s*1\s+1\s+4rem/);
  });
  it('the figures wrap below the name instead of crushing it when text is enlarged', () => {
    expect(rule(products, '.product-row__link')).toMatch(/flex-wrap:\s*wrap/);
  });
  it('the status never shrinks', () => {
    expect(rule(products, '.product-row__status')).toMatch(/flex:\s*none/);
  });
  it('the chevron sits outside the wrapping flow, with its place reserved by end padding, so it cannot orphan', () => {
    expect(rule(products, '.product-row__link')).toMatch(/position:\s*relative/);
    expect(rule(products, '.product-row__link')).toMatch(/padding:[^;]*calc\(var\(--space-4\)\s*\+\s*1rem\)/);
    const chevron = rule(products, '.product-row__chevron');
    expect(chevron).toMatch(/position:\s*absolute/);
    expect(chevron).toMatch(/inset-inline-end:/);
  });
});

describe('one status system', () => {
  it('the row no longer carries its own copy of the badge look (the shared .badge draws it)', () => {
    expect(products).not.toMatch(/\.product-row__status--/);
    const body = rule(products, '.product-row__status');
    expect(body).not.toMatch(/background|border|border-radius|padding|font-size|white-space|(?<![\w-])color\s*:/);
  });
});
