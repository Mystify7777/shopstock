// Redesign R1: the shared variants and quantity tokens, at the CSS level.
//
// jsdom performs no layout or cascade, so this pins the rules (and the absence
// of sizing in the button variants) rather than rendered colors. Rendered
// appearance is verified in a real browser. Contrast for these pairings lives
// in tokens.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const base = read('base.css');
const tokensCss = read('tokens.css');

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `rule "${selector}"`).not.toBeNull();
  return match[1];
}

describe('quantity typography tokens', () => {
  const size = (name) => {
    const m = tokensCss.match(new RegExp(`${name}:\\s*([\\d.]+)rem\\s*;`));
    expect(m, name).not.toBeNull();
    return parseFloat(m[1]);
  };
  it('quantity is larger than body text, and display is larger than quantity', () => {
    expect(size('--font-size-quantity')).toBeGreaterThan(size('--font-size-body'));
    expect(size('--font-size-display')).toBeGreaterThan(size('--font-size-quantity'));
  });
});

describe.each(['.quiet-action', '.danger-action'])('%s (button variant)', (selector) => {
  it('does not size the button: height and touch target come from the base button rule', () => {
    // (?<![\w-]) keeps this to whole property names: `height` must not be
    // matched inside `min-height`, and a property merely containing one of
    // these words is not a sizing declaration.
    expect(rule(base, selector)).not.toMatch(
      /(?<![\w-])(?:min-height|max-height|min-width|max-width|height|width|padding)\s*:/,
    );
  });
});

describe('.quiet-action hover and active backgrounds', () => {
  // The quiet button's contrast claim depends on the backgrounds the BASE
  // button rules put behind it. Pin those to the tokens tokens.test.js checks.
  it('the base button hover and active rules use surface-hover and surface-active', () => {
    const hover = rule(base, "button:hover:not(:disabled):not([aria-disabled='true'])");
    const active = rule(base, "button:active:not(:disabled):not([aria-disabled='true'])");
    expect(hover).toMatch(/background:\s*var\(--color-surface-hover\)/);
    expect(active).toMatch(/background:\s*var\(--color-surface-active\)/);
  });
});

describe('.quiet-action', () => {
  it('is transparent with a transparent border, so its box matches any other button', () => {
    const body = rule(base, '.quiet-action');
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/border-color:\s*transparent/);
    expect(body).toMatch(/color:\s*var\(--color-primary-active\)/);
  });
});

describe('.danger-action', () => {
  it('uses the danger tokens, with hover and active states that skip disabled buttons', () => {
    const body = rule(base, '.danger-action');
    expect(body).toMatch(/background:\s*var\(--color-danger\)/);
    expect(body).toMatch(/color:\s*var\(--color-text-inverse\)/);
    const hover = rule(
      base,
      ".danger-action:hover:not(:disabled):not([aria-disabled='true']),\n.danger-action:active:not(:disabled):not([aria-disabled='true'])",
    );
    expect(hover).toMatch(/background:\s*var\(--color-danger-fg\)/);
  });
});

describe('.badge', () => {
  it.each([
    ['.badge--low', 'stock-low'],
    ['.badge--out', 'stock-out'],
  ])('%s uses the %s status tokens (bg, fg and border)', (selector, state) => {
    const body = rule(base, selector);
    expect(body).toMatch(new RegExp(`background:\\s*var\\(--color-${state}-bg\\)`));
    expect(body).toMatch(new RegExp(`color:\\s*var\\(--color-${state}-fg\\)`));
    expect(body).toMatch(new RegExp(`border-color:\\s*var\\(--color-${state}-border\\)`));
  });
  it('ok is plain text with no tint, so rows needing attention stand out', () => {
    const body = rule(base, '.badge--ok');
    expect(body).not.toMatch(/background/);
  });
  it('never wraps its words', () => {
    expect(rule(base, '.badge')).toMatch(/white-space:\s*nowrap/);
  });
});

describe('.notice', () => {
  it.each(['info', 'warning', 'danger'])('--%s uses the %s tokens, including the accent edge', (s) => {
    const body = rule(base, `.notice--${s}`);
    expect(body).toMatch(new RegExp(`background:\\s*var\\(--color-${s}-bg\\)`));
    expect(body).toMatch(new RegExp(`color:\\s*var\\(--color-${s}-fg\\)`));
    expect(body).toMatch(new RegExp(`border-color:\\s*var\\(--color-${s}-border\\)`));
    expect(body).toMatch(new RegExp(`border-inline-start-color:\\s*var\\(--color-${s}\\)`));
  });
  it('carries a visible accent edge in the base rule', () => {
    expect(rule(base, '.notice')).toMatch(/border-inline-start-width:/);
  });
});
