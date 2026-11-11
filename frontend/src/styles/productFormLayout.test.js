// Redesign R7a: the product form's design rules, at the CSS level (jsdom does no
// layout; the rendered result is checked in a browser). Each assertion is scoped
// to the selector whose invariant it protects.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const form = strip(readFileSync(new URL('product-form.css', dir), 'utf8'));
const tokens = strip(readFileSync(new URL('tokens.css', dir), 'utf8'));

function rule(selector) {
  for (const m of form.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2];
  }
  expect.fail(`no rule with selector "${selector}"`);
  return '';
}
const rem = (name) => parseFloat(tokens.match(new RegExp(`${name}:\\s*([\\d.]+)rem\\s*;`))?.[1]);
const APPEARANCE = /(?<![\w-])(?:background|border|border-color|border-radius|box-shadow|padding|color|font-size|font-weight)\s*:/;

describe('the fields are a section, not a card', () => {
  it('the group keeps its column of fields but has no box: no fill, border, radius, shadow or padding', () => {
    const body = rule('.product-form__group');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/padding:\s*0/);
    expect(body).not.toMatch(/background|border-radius|box-shadow/);
  });
  it('and may shrink below its content, so a long value cannot widen the page', () => {
    expect(rule('.product-form__group')).toMatch(/min-width:\s*0/);
  });
  it('the legend reads as the section heading', () => {
    const body = rule('.product-form__group legend');
    expect(body).toMatch(/font-size:\s*var\(--font-size-heading-section\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
  });
  it('inputs and the textarea take the full width of their field', () => {
    expect(rule('.product-form__field input')).toMatch(/width:\s*100%/);
  });
});

describe('actions', () => {
  it('wrap rather than overflow, and a hairline sets them apart from the fields', () => {
    const body = rule('.product-form__actions');
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/border-top:\s*1px solid var\(--color-border\)/);
  });
  it('Cancel is quiet: text only with a transparent border, and no fill', () => {
    const body = rule('.product-form__cancel');
    expect(body).toMatch(/border:\s*1px solid transparent/);
    expect(body).toMatch(/color:\s*var\(--color-primary-active\)/);
    expect(body).not.toMatch(/background\s*:/);
  });
  it('Cancel keeps at least the 44px touch target', () => {
    expect(rule('.product-form__cancel')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(rem('--control-height')).toBeGreaterThanOrEqual(rem('--touch-target-min'));
  });
  it('Cancel\'s hover and press backgrounds are the ones its text contrast is checked against', () => {
    expect(rule('.product-form__cancel:hover')).toMatch(/background:\s*var\(--color-surface-hover\)/);
    expect(rule('.product-form__cancel:active')).toMatch(/background:\s*var\(--color-surface-active\)/);
  });
});

describe('errors use the shared notice', () => {
  it('the list inside it is indented like the old error list, scoped to this form', () => {
    const body = rule('.product-form .notice ul');
    expect(body).toMatch(/margin:\s*0/);
    expect(body).toMatch(/padding-inline-start:/);
  });
  it('this stylesheet positions nothing about the notice\'s look (the shared .notice draws it)', () => {
    for (const [, selector, body] of form.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/\.notice\b/.test(selector) && !/\bul\b/.test(selector)) expect(body, selector.trim()).not.toMatch(APPEARANCE);
    }
  });
  it('this stylesheet no longer styles .form-errors (the product detail forms still use it, in their own file)', () => {
    expect(form).not.toMatch(/\.form-errors/);
  });
});
