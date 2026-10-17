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
const shellCss = read('shell.css');
const dashboardCss = read('dashboard.css');
const classificationsCss = read('classifications.css');
const productsCss = read('products.css');
const productDetailCss = read('product-detail.css');
const productFormCss = read('product-form.css');

// Every component stylesheet (tokens.css itself is defined separately).
const STYLESHEETS = [
  ['base.css', baseCss],
  ['shell.css', shellCss],
  ['dashboard.css', dashboardCss],
  ['classifications.css', classificationsCss],
  ['products.css', productsCss],
  ['product-detail.css', productDetailCss],
  ['product-form.css', productFormCss],
];

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

  describe('prefers-reduced-motion', () => {
    const DURATIONS = ['--duration-fast', '--duration-base', '--duration-slow'];

    // Lightweight helpers for the checks below -- deliberately NOT a general
    // CSS parser. They assume the stylesheets are valid CSS (they are authored
    // in this repo and must build), and they throw on the malformed input they
    // would otherwise misread silently: an unterminated comment or string, a
    // stray '}', or an unclosed '{'. Anything beyond that (selector grammar,
    // @-rule semantics, escapes outside strings) is out of scope.

    // Returns `css` with every comment and the contents of every quoted string
    // replaced by spaces. Length and positions are preserved, so indices into
    // the result are valid indices into the original.
    function maskCssNoise(css) {
      let out = '';
      for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') {
          const close = css.indexOf('*/', i + 2);
          if (close === -1) throw new Error('Malformed CSS: unterminated comment');
          out += ' '.repeat(close + 2 - i);
          i = close + 1;
        } else if (c === '"' || c === "'") {
          let j = i + 1;
          while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
          if (j >= css.length) throw new Error('Malformed CSS: unterminated string');
          out += c + ' '.repeat(j - i - 1) + c;
          i = j;
        } else {
          out += c;
        }
      }
      return out;
    }

    // Splits CSS into its top-level blocks { selector, body, start, end }.
    // Braces, selectors and declarations inside comments or strings are never
    // mistaken for real syntax. Nested blocks stay inside their parent's body.
    function topLevelBlocks(css) {
      const masked = maskCssNoise(css);
      const blocks = [];
      let depth = 0;
      let selectorStart = 0;
      let bodyStart = -1;
      let selector = '';
      for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (c === '{') {
          if (depth === 0) {
            selector = masked.slice(selectorStart, i).trim();
            bodyStart = i + 1;
          }
          depth += 1;
        } else if (c === '}') {
          depth -= 1;
          if (depth < 0) throw new Error('Malformed CSS: unmatched closing brace');
          if (depth === 0) {
            blocks.push({ selector, body: masked.slice(bodyStart, i), start: selectorStart, end: i });
            selectorStart = i + 1;
          }
        } else if (c === ';' && depth === 0) {
          selectorStart = i + 1;
        }
      }
      if (depth !== 0) throw new Error('Malformed CSS: unclosed block');
      return blocks;
    }

    // True if any rule at any nesting depth, outside comments and strings,
    // declares `scroll-behavior: smooth` (any case, with or without !important).
    const forcesSmoothScroll = (css) => /scroll-behavior\s*:\s*smooth\b/i.test(maskCssNoise(css));

    const blocks = topLevelBlocks(tokensCss);
    const REDUCED = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/;
    const reducedBlock = blocks.find((blk) => REDUCED.test(blk.selector));
    const baseBlock = blocks.find(
      (blk) => blk.selector === ':root' && DURATIONS.every((d) => new RegExp(`${d}:\\s*\\d+ms\\s*;`).test(blk.body))
    );

    it('has a real @media (prefers-reduced-motion: reduce) block (not text inside a comment or string literal)', () => {
      expect(reducedBlock).toBeDefined();
    });

    it('defines every base duration as a millisecond value in a top-level :root block', () => {
      expect(baseBlock).toBeDefined();
    });

    it('collapses every duration token to 0.01ms on :root inside the reduced-motion block', () => {
      const inner = topLevelBlocks(reducedBlock.body).find((blk) => blk.selector === ':root');
      expect(inner).toBeDefined();
      for (const d of DURATIONS) {
        expect(inner.body).toMatch(new RegExp(`${d}:\\s*0\\.01ms\\s*;`));
      }
    });

    // A static source-position guard only. It proves that no top-level block
    // other than the reduced-motion block declares a --duration-* token at a
    // later position in the file. It does NOT evaluate selector specificity,
    // !important, or computed styles, so it is not proof that reduced motion
    // wins everywhere; that is a computed-style question for a real browser.
    it('no top-level block other than the reduced-motion block declares a --duration-* token after the reduced-motion block starts', () => {
      const declaring = blocks.filter((blk) => blk !== reducedBlock && /--duration-(?:fast|base|slow)\s*:/.test(blk.body));
      expect(declaring).toContain(baseBlock);
      for (const blk of declaring) {
        expect(blk.end, `block "${blk.selector}"`).toBeLessThan(reducedBlock.start);
      }
    });

    it('no stylesheet forces smooth scrolling, at any nesting depth (scroll-behavior is not covered by the duration tokens)', () => {
      for (const [file, css] of [['tokens.css', tokensCss], ...STYLESHEETS]) {
        expect(forcesSmoothScroll(css), file).toBe(false);
      }
    });

    describe('the CSS helpers used above', () => {
      it.each([
        ['an unterminated comment', 'a { b: c; } /* never closed'],
        ['an unterminated string', 'a { content: "never closed; }'],
        ['a stray closing brace', 'a { b: c; } }'],
        ['an unclosed block', 'a { b: c;']
      ])('topLevelBlocks rejects %s', (_label, css) => {
        expect(() => topLevelBlocks(css)).toThrow(/Malformed CSS/);
      });

      it('topLevelBlocks ignores braces and selectors inside comments and strings', () => {
        const blocks = topLevelBlocks('/* x { */ a { content: "}{"; b: c; }');
        expect(blocks).toHaveLength(1);
        expect(blocks[0].selector).toBe('a');
      });

      it.each([
        ['a top-level rule', 'html { scroll-behavior: smooth; }'],
        ['a rule nested in @media', '@media (min-width: 1px) { html { scroll-behavior: smooth; } }'],
        ['a rule nested two levels deep', '@media screen { @supports (a: b) { html { scroll-behavior:smooth } } }'],
        ['upper case with !important', 'html { SCROLL-BEHAVIOR: SMOOTH !important; }']
      ])('forcesSmoothScroll detects %s', (_label, css) => {
        expect(forcesSmoothScroll(css)).toBe(true);
      });

      it.each([
        ['auto', 'html { scroll-behavior: auto; }'],
        ['text in a comment', '/* html { scroll-behavior: smooth; } */ a { b: c; }'],
        ['text in a string', 'a::after { content: "scroll-behavior: smooth"; }']
      ])('forcesSmoothScroll does not flag %s', (_label, css) => {
        expect(forcesSmoothScroll(css)).toBe(false);
      });
    });
  });

  // Reduced motion works by collapsing the --duration-* tokens (above). That
  // only protects a rule that takes its duration FROM a token, so a
  // hard-coded duration anywhere would silently opt out. Every transition and
  // animation in the app's stylesheets must use a duration token.
  it('every transition and animation takes its duration from a --duration-* token', () => {
    const offenders = [];
    for (const [file, css] of STYLESHEETS) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of stripped.matchAll(/\b(transition|animation)(?:-duration)?\s*:\s*([^;}]+)/g)) {
        const value = match[2];
        if (/\bnone\b/.test(value)) continue;
        if (!/var\(--duration-(fast|base|slow)\)/.test(value) || /(^|[\s,])\d*\.?\d+m?s\b/.test(value)) {
          offenders.push(`${file}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the skip link animates with the tokenized duration, so reduced motion removes the animation', () => {
    const shell = STYLESHEETS.find(([file]) => file === 'shell.css')[1];
    const rule = shell.match(/\.skip-link\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/transition:[^;]*var\(--duration-base\)/);
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
    expect(shellCss).not.toMatch(/gradient\(/);
    expect(dashboardCss).not.toMatch(/gradient\(/);
    expect(classificationsCss).not.toMatch(/gradient\(/);
    expect(productsCss).not.toMatch(/gradient\(/);
    expect(productDetailCss).not.toMatch(/gradient\(/);
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

describe.each(STYLESHEETS)('%s', (_name, css) => {
  it('only references tokens that exist in tokens.css', () => {
    const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = [...new Set(used)].filter((n) => tokens[n] === undefined);
    expect(missing).toEqual([]);
  });

  it('never removes outlines', () => {
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe('base.css focus', () => {
  it('keeps a visible :focus-visible treatment', () => {
    expect(baseCss).toMatch(/:focus-visible\s*{[^}]*outline:\s*var\(--focus-ring\)/);
  });
});

describe('classifications.css removal dialog', () => {
  // The panel is styled through an attribute selector on its role, so a role
  // change that misses the stylesheet silently strips the styling and no
  // behavioral test would notice.
  it('is styled by the role the component actually renders (dialog), with no stale alertdialog selector', () => {
    const component = readFileSync(new URL('../components/ClassificationRemoval.jsx', import.meta.url), 'utf8');
    expect(component).toContain('role="dialog"');
    expect(component).not.toContain('role="alertdialog"');
    expect(classificationsCss).toContain(".classifications [role='dialog']");
    expect(classificationsCss).not.toContain('alertdialog');
  });
});
