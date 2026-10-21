// Phase 7H Slice 3: viewport-aware focus and scrolling, at the CSS level.
//
// jsdom performs no layout, so this cannot show that focus is kept clear of
// the fixed chrome. It pins the rules that do it, so a later edit cannot
// quietly reintroduce a second competing rule or drop the dvh fallback. The
// behaviour itself was verified in a real browser.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => [f, strip(readFileSync(new URL(f, dir), 'utf8'))])
);

describe('root scroll-padding (keeps focus clear of the fixed chrome)', () => {
  it('is declared in exactly one place, so competing rules cannot override each other', () => {
    const owners = Object.entries(sheets)
      .filter(([, css]) => /scroll-padding/.test(css))
      .map(([name]) => name);
    expect(owners).toEqual(['shell.css']);
    expect(sheets['shell.css'].match(/scroll-padding-top\s*:/g)).toHaveLength(1);
    expect(sheets['shell.css'].match(/scroll-padding-bottom\s*:/g)).toHaveLength(1);
  });

  const rootRule = sheets['shell.css'].match(/(?:^|\})\s*html\s*\{([^}]*)\}/)?.[1] ?? '';

  it('is applied to the document element', () => {
    expect(rootRule).not.toBe('');
  });

  it('the top clears the sticky header', () => {
    expect(rootRule).toMatch(/scroll-padding-top:\s*var\(--chrome-top\)\s*;/);
  });

  it('the bottom clears the larger of the mobile bar and the undo notice (the notice measurement already includes the bar)', () => {
    expect(rootRule).toMatch(/scroll-padding-bottom:\s*max\(\s*var\(--chrome-bottom\)\s*,\s*var\(--undo-clearance\)\s*\)\s*;/);
  });

  it('the page still reserves room at the bottom for the notice, so the last content can scroll above it', () => {
    expect(sheets['product-detail.css']).toMatch(/\.product-detail\s*\{[^}]*padding-bottom:\s*var\(--undo-clearance\)/);
  });
});

describe('runtime tokens', () => {
  it.each(['--chrome-top', '--chrome-bottom', '--undo-clearance'])('%s rests at 0px until something is measured', (name) => {
    expect(sheets['tokens.css']).toMatch(new RegExp(`${name}:\\s*0px\\s*;`));
  });
});

describe('viewport height units', () => {
  // 100vh counts the area behind mobile browser toolbars that collapse as you
  // scroll, so a "full height" layout overshoots the visible area. 100dvh is
  // the visible height. Browsers without dvh ignore that line and keep the vh
  // fallback, so it must come AFTER 100vh to win where it is supported.
  it('every full-height min-height is followed immediately by its 100dvh refinement', () => {
    let seen = 0;
    for (const [name, css] of Object.entries(sheets)) {
      const lines = css.split('\n').map((l) => l.trim());
      lines.forEach((line, i) => {
        if (/^min-height:\s*100vh\s*;/.test(line)) {
          seen += 1;
          expect(lines[i + 1], `${name}: "${line}" is not followed by 100dvh`).toMatch(/^min-height:\s*100dvh\s*;/);
        }
      });
    }
    expect(seen).toBe(4); // body, app shell, error screen, login: update this if a full-height layout is added
  });

  it('no layout uses 100vh without the dvh pairing, in any other property', () => {
    for (const [name, css] of Object.entries(sheets)) {
      const stray = css.match(/(?<!min-)\bheight:\s*100vh/g);
      expect(stray, name).toBeNull();
    }
  });
});
