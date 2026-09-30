import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Issue #17 contracts worth protecting:
//  1. tokens.css covers every required category (later phases consume
//     these by name).
//  2. Every defined semantic text/background pairing meets WCAG AA.
//  3. base.css never references a token that does not exist (a typo would
//     silently drop the declaration in the browser).

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const tokensCss = read('tokens.css');
const baseCss = read('base.css');

// Parse `--name: value;` declarations from the first :root block only
// (later blocks are media-query overrides).
function parseTokens(css) {
  const start = css.indexOf(':root');
  const end = css.indexOf('\n}\n', start);
  const block = css.slice(start, end);
  const tokens = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

const tokens = parseTokens(tokensCss);

function resolve(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Circular token reference: ${name}`);
  seen.add(name);
  const value = tokens[name];
  if (value === undefined) throw new Error(`Undefined token: ${name}`);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(ref[1], seen) : value;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fgName, bgName) {
  const a = luminance(resolve(fgName));
  const b = luminance(resolve(bgName));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = [
  '--color-page',
  '--color-surface',
  '--color-surface-elevated',
  '--color-surface-muted',
  '--color-surface-hover',
  '--color-surface-active',
];

const STATES = [
  'success',
  'warning',
  'danger',
  'info',
  'stock-normal',
  'stock-low',
  'stock-out',
  'offline',
  'syncing',
  'failed',
];

describe('tokens.css: required coverage (Issue #17)', () => {
  const required = [
    // colors
    '--color-page',
    '--color-surface',
    '--color-surface-elevated',
    '--color-border',
    '--color-text',
    '--color-text-muted',
    '--color-primary',
    '--color-focus',
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-info',
    '--color-stock-normal',
    '--color-stock-low',
    '--color-stock-out',
    '--color-offline',
    '--color-syncing',
    '--color-failed',
    '--color-overlay',
    // typography
    '--font-family',
    '--font-size-heading-page',
    '--font-size-body',
    '--font-size-label',
    '--font-size-helper',
    '--font-size-error',
    '--font-weight-regular',
    '--font-weight-bold',
    '--line-height-body',
    // spacing, radii, elevation
    '--space-1',
    '--space-7',
    '--radius-control',
    '--radius-card',
    '--radius-panel',
    '--radius-full',
    '--shadow-1',
    '--shadow-3',
    // layout, controls, motion, layers, focus ring
    '--layout-width-content',
    '--gutter-mobile',
    '--gutter-desktop',
    '--control-height',
    '--duration-base',
    '--ease-standard',
    '--z-dropdown',
    '--z-sticky',
    '--z-dialog',
    '--z-toast',
    '--z-overlay',
    '--focus-ring-width',
    '--focus-ring-offset',
  ];

  it.each(required)('defines %s', (name) => {
    expect(tokens[name]).toBeDefined();
  });

  it('every token alias resolves (no dangling or circular references)', () => {
    for (const name of Object.keys(tokens)) {
      expect(() => resolve(name)).not.toThrow();
    }
  });

  it('collapses motion durations under prefers-reduced-motion', () => {
    const reduced = tokensCss.slice(tokensCss.indexOf('prefers-reduced-motion'));
    for (const d of ['--duration-fast', '--duration-base', '--duration-slow']) {
      expect(reduced).toMatch(new RegExp(`${d}:\\s*0\\.01ms`));
    }
  });

  it('z-index layers are strictly ordered', () => {
    const z = ['--z-sticky', '--z-dropdown', '--z-overlay', '--z-dialog', '--z-toast'].map((n) =>
      Number(tokens[n]),
    );
    expect(z).toEqual([...z].sort((a, b) => a - b));
    expect(new Set(z).size).toBe(z.length);
  });

  it('contains no gradients', () => {
    expect(tokensCss).not.toMatch(/gradient\(/);
    expect(baseCss).not.toMatch(/gradient\(/);
  });
});

describe('tokens.css: WCAG AA contrast', () => {
  const AA_TEXT = 4.5;
  const AA_UI = 3;

  describe('text on surfaces', () => {
    const cases = [];
    for (const fg of ['--color-text', '--color-text-secondary', '--color-text-muted']) {
      for (const bg of SURFACES) cases.push([fg, bg]);
    }
    it.each(cases)('%s on %s >= 4.5:1', (fg, bg) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });

  describe('primary action', () => {
    it.each(['--color-primary', '--color-primary-hover', '--color-primary-active'])(
      'on-primary text on %s >= 4.5:1',
      (bg) => {
        expect(contrast('--color-on-primary', bg)).toBeGreaterThanOrEqual(AA_TEXT);
      },
    );
    it.each(['--color-page', '--color-surface'])('primary as link text on %s >= 4.5:1', (bg) => {
      expect(contrast('--color-primary', bg)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast('--color-primary-hover', bg)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it('selected foreground on selected background >= 4.5:1', () => {
      expect(contrast('--color-selected-fg', '--color-selected-bg')).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });

  describe('semantic states', () => {
    it.each(STATES)('%s: fg on tinted bg >= 4.5:1', (s) => {
      expect(contrast(`--color-${s}-fg`, `--color-${s}-bg`)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it.each(STATES)('%s: solid usable as text on page and surface >= 4.5:1', (s) => {
      expect(contrast(`--color-${s}`, '--color-page')).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(`--color-${s}`, '--color-surface')).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it.each(STATES)('%s: inverse text on solid >= 4.5:1', (s) => {
      expect(contrast('--color-text-inverse', `--color-${s}`)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });

  describe('UI boundaries and focus (3:1)', () => {
    it.each(['--color-page', '--color-surface'])('border-strong on %s', (bg) => {
      expect(contrast('--color-border-strong', bg)).toBeGreaterThanOrEqual(AA_UI);
    });
    it.each(['--color-page', '--color-surface', '--color-surface-muted'])('focus ring on %s', (bg) => {
      expect(contrast('--color-focus', bg)).toBeGreaterThanOrEqual(AA_UI);
    });
    it('selected border on surface', () => {
      expect(contrast('--color-selected-border', '--color-surface')).toBeGreaterThanOrEqual(AA_UI);
    });
    it('invalid (danger) border on surface', () => {
      expect(contrast('--color-danger', '--color-surface')).toBeGreaterThanOrEqual(AA_UI);
    });
  });
});

describe('base.css', () => {
  it('only references tokens that exist in tokens.css', () => {
    const used = [...baseCss.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = [...new Set(used)].filter((n) => tokens[n] === undefined);
    expect(missing).toEqual([]);
  });

  it('keeps a visible :focus-visible treatment and never removes outlines globally', () => {
    expect(baseCss).toMatch(/:focus-visible\s*{[^}]*outline:\s*var\(--focus-ring\)/);
    expect(baseCss).not.toMatch(/outline:\s*(none|0)\b/);
  });
});
