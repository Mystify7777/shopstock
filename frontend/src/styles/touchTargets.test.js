// Phase 7H Slice 3: the 44 x 44 CSS-px touch-target contract, at the CSS level.
//
// jsdom performs no layout, so these tests cannot prove a control renders at
// 44px. They pin the rules that produce it, so a later edit cannot quietly
// shrink a control. Actual rendered sizes are verified in a real browser.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = { base: read('base.css'), products: read('products.css'), detail: read('product-detail.css'), tokens: read('tokens.css') };

// The declarations of the first flat rule whose selector is exactly `selector`.
function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `rule "${selector}"`).not.toBeNull();
  return match[1];
}

const TOUCH = /var\(--touch-target-min\)/;

describe('touch targets (CSS contract)', () => {
  it('the touch-target token is 44px at the default font size (2.75rem)', () => {
    expect(css.tokens).toMatch(/--touch-target-min:\s*2\.75rem\s*;/);
  });

  describe('.touch-link (standalone links)', () => {
    const body = rule(css.base, '.touch-link');
    it('is a flex box so min-height applies to an inline anchor, and centers its text', () => {
      expect(body).toMatch(/display:\s*inline-flex/);
      expect(body).toMatch(/align-items:\s*center/);
    });
    it('is at least the touch-target minimum in both dimensions', () => {
      expect(body).toMatch(new RegExp(`min-height:\\s*${TOUCH.source}`));
      expect(body).toMatch(new RegExp(`min-width:\\s*${TOUCH.source}`));
    });
  });

  it('filter chips: the whole chip (which the real checkbox covers) meets the minimum', () => {
    expect(rule(css.products, '.chip__label')).toMatch(new RegExp(`min-height:\\s*${TOUCH.source}`));
  });

  it('history "Reverse this action" buttons meet the minimum', () => {
    expect(rule(css.detail, '.history-entry button')).toMatch(new RegExp(`min-height:\\s*${TOUCH.source}`));
  });

  it('the base button and form-control rules meet the minimum', () => {
    expect(rule(css.base, 'button')).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(css.tokens).toMatch(/--control-height:\s*2\.75rem\s*;/);
  });

  // The small control token (2.25rem = 36px) is what made two controls too
  // small. It stays defined, but no stylesheet may size anything with it.
  it('no stylesheet sizes a control with the sub-44px --control-height-sm token', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'tokens.css')) {
      expect(read(name), name).not.toMatch(/var\(--control-height-sm\)/);
    }
  });
});
