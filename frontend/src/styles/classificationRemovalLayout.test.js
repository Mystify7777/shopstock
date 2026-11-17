// Redesign R8b: the removal panel's design rules, at the CSS level. Each
// assertion is scoped to the selector whose invariant it protects. The page's
// tabs, rows and forms are R8a and are asserted in classificationsLayout.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const css = readFileSync(new URL('classifications.css', dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.split(',').map((s) => s.trim()),
  body,
}));
function rule(selector) {
  const found = rules.find((r) => r.selectors.includes(selector));
  expect(found, `rule "${selector}"`).toBeDefined();
  return found.body;
}
const DIALOG = ".classifications [role='dialog']";
const SHADOW = /box-shadow\s*:\s*(?=\S)(?!none\b)/;
const APPEARANCE = /(?<![\w-])(?:background|border|border-color|border-radius|box-shadow|color|font-weight)\s*:/;

describe('the panel is flat and bordered', () => {
  it('has the surface fill, a 1px border and the card radius', () => {
    const body = rule(DIALOG);
    expect(body).toMatch(/background:\s*var\(--color-surface\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
  });
  it('has no shadow and no elevation, in this rule or in any rule for the panel', () => {
    for (const { selectors, body } of rules.filter((r) => r.selectors.some((s) => s.includes("[role='dialog']")))) {
      expect(body, selectors.join(', ')).not.toMatch(SHADOW);
      expect(body, selectors.join(', ')).not.toMatch(/surface-elevated/);
    }
  });
  it('stays scoped under .classifications, so no other dialog (the stock over-removal warning) is affected', () => {
    for (const { selectors } of rules.filter((r) => r.selectors.some((s) => s.includes("[role='dialog']")))) {
      for (const s of selectors.filter((x) => x.includes("[role='dialog']"))) {
        expect(s.startsWith('.classifications')).toBe(true);
      }
    }
  });
});

describe('layout: blocks on their own lines, the buttons wrapping at the end', () => {
  it('the panel is a wrapping flex container', () => {
    const body = rule(DIALOG);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });
  it('every block that is not a button takes a full line and may shrink', () => {
    const body = rule(`${DIALOG} > :not(button)`);
    expect(body).toMatch(/flex:\s*1 1 100%/);
    expect(body).toMatch(/min-width:\s*0/);
  });
  it('the buttons share a line, shrink below their label and wrap it, so large text cannot push them out', () => {
    const body = rule(`${DIALOG} > button`);
    expect(body).toMatch(/flex:\s*0 1 auto/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('does not size the buttons: their 44px height comes from the base button rule', () => {
    expect(rule(`${DIALOG} > button`)).not.toMatch(/(?<![\w-])(?:min-height|max-height|height)\s*:/);
  });
  it('the panel has no fixed width', () => {
    expect(rule(DIALOG)).not.toMatch(/(?<![\w-])(?:width|min-width|max-width)\s*:/);
  });
});

describe('the affected-products list is compact and wraps long names', () => {
  it('items are tight and a long product name wraps instead of widening the panel', () => {
    const body = rule(`${DIALOG} li`);
    expect(body).toMatch(/margin:\s*0 0 var\(--space-1\)/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('failures use the shared notice', () => {
  it('this stylesheet only lays out what is inside them, and never redeclares their look', () => {
    for (const { selectors, body } of rules.filter((r) => r.selectors.some((s) => /\.notice\b/.test(s)))) {
      expect(body, selectors.join(', ')).not.toMatch(APPEARANCE);
    }
  });
  it('the old red alert look for the panel is gone', () => {
    expect(css).not.toMatch(/\[role='dialog'\]\s*\[role='alert'\]/);
  });
  it('the "could not check" panel and the loading line are laid out in the row, wrapping', () => {
    expect(rule(".classifications__list > li > [role='alert']")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.classifications__list > li > p')).toMatch(/flex:\s*1 1 100%/);
  });
});
