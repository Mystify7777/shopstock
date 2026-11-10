// Redesign R6: the Product Detail layout and the fixed-chrome stacking contract,
// at the CSS level. jsdom does no layout, so these pin the rules; the stacking
// itself (positions, clearance, the keyboard) was measured in a real browser.
//
// Each assertion is scoped to the selector, and where it matters the media
// query, whose invariant it protects.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const detail = read('product-detail.css');
const tokens = read('tokens.css');

// Split a stylesheet into top-level chunks, keeping @media blocks whole.
function topLevel(css) {
  const chunks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        chunks.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  return chunks;
}
const chunks = topLevel(detail);
const MOBILE = '@media (max-width: 47.999rem)';
const TALL_PHONE = '@media (max-width: 47.999rem) and (min-height: 36rem)';
const WIDE = '@media (min-width: 48rem)';

// Every rule for a selector, with the media query (or '' for none) it sits in.
function rulesFor(selector) {
  const found = [];
  for (const chunk of chunks) {
    const query = chunk.startsWith('@media') ? chunk.slice(0, chunk.indexOf('{')).trim() : '';
    for (const m of chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').map((s) => s.replace(/@media[^{]*\{/, '').trim()).includes(selector)) {
        found.push({ query, body: m[2] });
      }
    }
  }
  return found;
}

function bodyIn(scopeChunks, selector) {
  for (const chunk of scopeChunks) {
    for (const m of chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').map((s) => s.replace(/@media[^{]*\{/, '').trim()).includes(selector)) return m[2];
    }
  }
  expect.fail(`no rule "${selector}"`);
  return '';
}
const plain = chunks.filter((c) => !c.startsWith('@media'));
const mobile = chunks.filter((c) => c.startsWith(MOBILE));
const tallPhone = chunks.filter((c) => c.startsWith(TALL_PHONE));
const wide = chunks.filter((c) => c.startsWith(WIDE));
const px = (name) => parseFloat(tokens.match(new RegExp(`${name}:\\s*([\\d.]+)(?:rem)?\\s*;`))?.[1]);

describe('stock-action bar: wide screens', () => {
  it('is not fixed by default: the base rule leaves it in the page', () => {
    expect(bodyIn(plain, '.product-detail__actions')).not.toMatch(/position\s*:/);
  });
  it('its buttons size to their content instead of stretching across a wide page', () => {
    expect(bodyIn(plain, '.product-detail__actions button')).toMatch(/flex:\s*0 1 auto/);
  });
});

describe('stock-action bar: phones', () => {
  // The fixed layer exists only on a phone whose viewport is tall enough for it.
  const bar = () => bodyIn(tallPhone, '.product-detail__actions');

  it('is fixed only when the viewport is also tall enough, in rem so it follows text size and zoom', () => {
    // Intentional exception to "fixed on mobile": below this height (enlarged
    // text, zoom, a phone held sideways) the bar stays in the page, because fixed
    // chrome would take most of the screen.
    expect(tallPhone).toHaveLength(1);
    const minHeight = Number(TALL_PHONE.match(/min-height:\s*([\d.]+)rem/)[1]);
    expect(minHeight).toBeGreaterThanOrEqual(30);
    // The bar's own rules: exactly one of them fixes it, and it is the height-gated one.
    const fixing = rulesFor('.product-detail__actions').filter(({ body }) => /position:\s*fixed/.test(body));
    expect(fixing).toHaveLength(1);
    expect(fixing[0].query).toBe(TALL_PHONE);
    // Every other rule for the bar (wide screens, phone width without the height gate) leaves position alone.
    const others = rulesFor('.product-detail__actions').filter(({ query }) => query !== TALL_PHONE);
    expect(others.length).toBeGreaterThan(0);
    for (const { body } of others) expect(body).not.toMatch(/position\s*:/);
  });
  it('the undo notice is fixed on its own rule, not through the bar\'s', () => {
    expect(rulesFor('.undo-notice').some(({ query, body }) => query === '' && /position:\s*fixed/.test(body))).toBe(true);
  });

  it('is fixed only inside the phone media query, edge to edge', () => {
    expect(bar()).toMatch(/position:\s*fixed/);
    expect(bar()).toMatch(/inset-inline:\s*0/);
  });
  it('sits on the MEASURED height of the bottom bar, with no pixel literal', () => {
    expect(bar()).toMatch(/bottom:\s*var\(--chrome-bottom-nav\)/);
    expect(bar()).not.toMatch(/bottom:\s*[\d.]/);
  });
  it('is in the same layer as the bottom bar, and under the undo notice', () => {
    expect(bar()).toMatch(/z-index:\s*var\(--z-sticky\)/);
    expect(bodyIn(plain, '.undo-notice')).toMatch(/z-index:\s*var\(--z-toast\)/);
    expect(px('--z-toast')).toBeGreaterThan(px('--z-sticky'));
  });
  it('its buttons share the bar equally and may shrink below their label (a label wraps rather than overflowing)', () => {
    const body = bodyIn(mobile, '.product-detail__actions button');
    expect(body).toMatch(/flex:\s*1 1 0/);
    expect(body).toMatch(/min-width:\s*0/);
  });
  it('a button label wraps instead of being clipped when text is enlarged', () => {
    const body = bodyIn(mobile, '.product-detail__actions button');
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('does not size the buttons: their 44px height comes from the base button rule', () => {
    for (const scope of [plain, mobile]) {
      expect(bodyIn(scope, '.product-detail__actions button')).not.toMatch(
        /(?<![\w-])(?:min-height|max-height|height)\s*:/,
      );
    }
  });
  it('while a text field has focus it leaves the fixed layer by going OUT of the flow, never into it', () => {
    const body = bodyIn(tallPhone, ".product-detail__actions[data-text-entry='true']");
    // static would move the form when focus leaves a field (a tap on Save would
    // slide away between pointer-down and pointer-up)
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).not.toMatch(/position:\s*(?:static|relative)/);
    expect(body).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/);
  });
  it('and then rests in the clearance already reserved for it, by the measured height, at the same width', () => {
    const body = bodyIn(tallPhone, ".product-detail__actions[data-text-entry='true']");
    expect(body).toMatch(/bottom:\s*calc\(-1\s*\*\s*var\(--stock-actions-height\)\)/);
    // as wide as the fixed bar (edge to edge), so its height, and the reservation, are the same
    expect(body).toMatch(/inset-inline:\s*calc\(-1\s*\*\s*var\(--gutter\)\)/);
    expect(bodyIn(plain, '.product-detail')).toMatch(/position:\s*relative/);
  });
});

describe('undo notice stacking', () => {
  it('on a phone it sits on the measured bottom bar and the measured action bar, with no assumed height', () => {
    const body = bodyIn(plain, '.undo-notice');
    expect(body).toMatch(
      /bottom:\s*calc\(var\(--chrome-bottom-nav\)\s*\+\s*var\(--stock-actions-height\)\s*\+\s*var\(--space-4\)\)/,
    );
    expect(body).not.toMatch(/control-height/);
  });
  it('on a wide screen, where nothing is stacked beneath it, it keeps its own offset', () => {
    expect(bodyIn(wide, '.undo-notice')).toMatch(/bottom:\s*var\(--space-5\)/);
  });
});

describe('quantity hierarchy', () => {
  it('the figure uses the display size, tabular and bold, and wraps rather than overflowing', () => {
    const body = bodyIn(plain, '.product-detail__quantity-figure');
    expect(body).toMatch(/font-size:\s*var\(--font-size-display\)/);
    expect(body).toMatch(/font-variant-numeric:\s*var\(--font-numeric\)/);
    expect(body).toMatch(/font-weight:\s*var\(--font-weight-bold\)/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('is larger than the quantity size used on rows and history', () => {
    expect(px('--font-size-display')).toBeGreaterThan(px('--font-size-quantity'));
    expect(bodyIn(plain, '.history-entry__amount')).toMatch(/font-size:\s*var\(--font-size-quantity\)/);
  });
  it('the row of figure and badge wraps instead of overflowing', () => {
    expect(bodyIn(plain, '.product-detail__quantity')).toMatch(/flex-wrap:\s*wrap/);
  });
  it('the product name may wrap: the header wraps and the name breaks anywhere', () => {
    expect(bodyIn(plain, '.product-detail__header')).toMatch(/flex-wrap:\s*wrap/);
    expect(bodyIn(plain, '.product-detail__header h1')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('Edit action', () => {
  it('is a quiet link: transparent border, no fill, at least the 44px touch target', () => {
    const body = bodyIn(plain, '.product-detail__edit');
    expect(body).toMatch(/border:\s*1px solid transparent/);
    expect(body).not.toMatch(/background\s*:/);
    expect(body).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(px('--control-height')).toBeGreaterThanOrEqual(px('--touch-target-min'));
  });
});

describe('stock history', () => {
  it('is one bordered list with dividers between entries, not a card per entry', () => {
    expect(bodyIn(plain, '.history-list')).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(bodyIn(plain, '.history-entry + .history-entry')).toMatch(/border-top:\s*1px solid/);
    expect(bodyIn(plain, '.history-entry')).not.toMatch(/border/);
  });
  it('the time sits at the far end of the entry\'s first line', () => {
    expect(bodyIn(plain, '.history-entry__time')).toMatch(/margin-inline-start:\s*auto/);
  });
});

describe('one status system', () => {
  it('no local badge remains', () => {
    expect(detail).not.toMatch(/\.stock-badge/);
  });
  it('the shared .badge may be positioned here, but its look is never redeclared', () => {
    const APPEARANCE = /(?<![\w-])(?:background|color|border|border-color|border-radius|padding|font-size|font-weight)\s*:/;
    const badgeRules = [...detail.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /\.badge\b/.test(selector));
    expect(badgeRules.length).toBeGreaterThan(0); // the positioning rule exists, so this is not vacuous
    for (const [, selector, body] of badgeRules) {
      expect(body, selector.trim()).not.toMatch(APPEARANCE);
    }
  });
});
