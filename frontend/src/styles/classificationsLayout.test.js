// Redesign R8a: the classifications page's layout rules, at the CSS level. Each
// assertion is scoped to the selector whose invariant it protects. The removal
// panel's own rules (R8b) are deliberately not asserted here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const css = readFileSync(new URL('classifications.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = readFileSync(new URL('tokens.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.split(',').map((s) => s.trim()),
  body,
}));
function rule(selector) {
  const found = rules.find((r) => r.selectors.includes(selector));
  expect(found, `rule "${selector}"`).toBeDefined();
  return found.body;
}
const rem = (name) => parseFloat(tokens.match(new RegExp(`${name}:\\s*([\\d.]+)rem\\s*;`))?.[1]);
const APPEARANCE = /(?<![\w-])(?:background|border|border-color|border-radius|box-shadow|padding|color|font-size|font-weight)\s*:/;

describe('the page heading', () => {
  it('may break its long word at large text, so it cannot widen the page', () => {
    expect(rule('.classifications h1')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('tabs: all four visible, readable and targetable, with no sideways scrolling', () => {
  const tabs = () => rule('.classifications__tabs');

  it('are a grid whose columns adapt, so four tabs sit 2 x 2 on a phone and stack at large text', () => {
    expect(tabs()).toMatch(/display:\s*grid/);
    expect(tabs()).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(8rem,\s*1fr\)\)/);
  });
  it('never scroll or clip: no horizontal overflow handling and no fixed width', () => {
    for (const selector of ['.classifications__tabs', '.classifications__tabs a']) {
      expect(rule(selector)).not.toMatch(/overflow(?:-x)?\s*:\s*(?:auto|scroll|hidden)|(?<![\w-])(?:width|min-width|max-width)\s*:/);
    }
  });
  it('a long label wraps inside its tab instead of widening it', () => {
    expect(rule('.classifications__tabs a')).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('each tab keeps at least the 44px touch target and is centred', () => {
    expect(rule('.classifications__tabs a')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(rem('--control-height')).toBeGreaterThanOrEqual(rem('--touch-target-min'));
    expect(rule('.classifications__tabs a')).toMatch(/justify-content:\s*center/);
  });
  it('the current tab differs in fill, border, weight and a bar, so it never rests on color alone', () => {
    const body = rule(".classifications__tabs a[aria-current='page']");
    expect(body).toMatch(/background:\s*var\(--color-selected-bg\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-selected-border\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
    expect(body).toMatch(/box-shadow:\s*inset/);
    // and the base tab does not already have that look
    expect(rule('.classifications__tabs a')).not.toMatch(/selected/);
  });
});

describe('items are one bordered list with dividers, not a card each', () => {
  it('the list has the surface, border and radius; rows have dividers and no box of their own', () => {
    expect(rule('.classifications__list')).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(rule('.classifications__list')).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(rule('.classifications__list > li + li')).toMatch(/border-top:\s*1px solid var\(--color-border\)/);
    expect(rule('.classifications__list > li')).not.toMatch(/(?<![\w-])border\s*:|border-radius|background|box-shadow/);
  });
  it('a row wraps: the name takes its own line and the actions follow', () => {
    expect(rule('.classifications__list > li')).toMatch(/display:\s*flex/);
    expect(rule('.classifications__list > li')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.classifications__name')).toMatch(/flex:\s*1 1 100%/);
  });
  it('a long name wraps, and is never truncated', () => {
    const body = rule('.classifications__name');
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).not.toMatch(/text-overflow|white-space:\s*nowrap/);
  });
  it('the rename form and the removal panel each take a full line inside a row', () => {
    const body = rule(".classifications__list > li > form");
    expect(body).toMatch(/flex:\s*1 1 100%/);
    expect(rule(".classifications__list > li > [role='dialog']")).toMatch(/flex:\s*1 1 100%/);
  });
  it('the removal panel spans the whole row, so padding the row cannot make it narrower than before', () => {
    const dialog = rules
      .filter((r) => r.selectors.includes(".classifications__list > li > [role='dialog']"))
      .map((r) => r.body)
      .join(';');
    expect(dialog).toMatch(/margin-inline:\s*calc\(-1\s*\*\s*var\(--space-4\)\)/);
    // the same amount the row pads itself by, so the two always cancel
    expect(rule('.classifications__list > li')).toMatch(/padding:\s*var\(--space-3\)\s+var\(--space-4\)/);
  });
  it('the list has no fixed width', () => {
    expect(rule('.classifications__list')).not.toMatch(/(?<![\w-])(?:width|min-width|max-width)\s*:/);
  });
});

describe('messages use the shared notice', () => {
  it('the stylesheet only spaces them, and never redeclares their look', () => {
    for (const { selectors, body } of rules.filter((r) => r.selectors.some((s) => /\.notice\b/.test(s)))) {
      expect(body, selectors.join(', ')).not.toMatch(APPEARANCE);
    }
  });
  it('the old red-text rule for form errors is gone', () => {
    expect(css).not.toMatch(/form\s*>\s*p\[role='alert'\]/);
  });
});

describe('what R8a leaves alone', () => {
  it('the removal panel selector is still styled here (its look belongs to R8b)', () => {
    expect(css).toContain(".classifications [role='dialog']");
  });
});
