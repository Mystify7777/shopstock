// Phase 7I: single-line name truncation, at the CSS level.
//
// jsdom performs no layout, so this pins the rules that produce the ellipsis
// and the guards around them; how it looks at 320px is a browser check.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (name) =>
  readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `rule "${selector}"`).not.toBeNull();
  return match[1];
}

describe('.text-truncate (shared single-line ellipsis)', () => {
  const body = rule(read('base.css'), '.text-truncate');

  it('clips to one line with an ellipsis and can shrink inside a flex row', () => {
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it('is not duplicated: the product row and dashboard rows rely on it instead of redeclaring it', () => {
    for (const name of ['products.css', 'dashboard.css']) {
      expect(read(name), name).not.toMatch(/text-overflow/);
    }
    expect(rule(read('products.css'), '.product-row__name')).not.toMatch(/overflow-wrap/);
  });
});

describe('dashboard rows keep the touch-target guarantee', () => {
  it('.dashboard__row-name does not override .touch-link\'s minimum width', () => {
    expect(rule(read('dashboard.css'), '.dashboard__row-name')).not.toMatch(/min-width/);
  });

  it('a status or activity detail beside a name never wraps under it when nowrap is requested', () => {
    expect(rule(read('dashboard.css'), '.dashboard__row-detail--nowrap')).toMatch(/white-space:\s*nowrap/);
  });
});
