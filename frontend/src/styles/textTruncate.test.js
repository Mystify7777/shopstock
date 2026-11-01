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

describe('stacked activity rows (7I)', () => {
  const dashboard = read('dashboard.css');

  it('are a column with the meta line beneath the name, never squeezed beside it', () => {
    const body = rule(dashboard, '.dashboard__row--stacked');
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/align-items:\s*flex-start/);
  });

  it('cap the name link at the row width so its ellipsis still applies, without touching min-width', () => {
    const body = rule(dashboard, '.dashboard__row--stacked .dashboard__row-name');
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).not.toMatch(/min-width/);
  });

  it('use the muted text token for the meta line', () => {
    expect(rule(dashboard, '.dashboard__row-meta')).toMatch(/color:\s*var\(--color-text-muted\)/);
  });
});

describe('product detail heading on small screens (7I)', () => {
  it('steps down to the section-heading size below the tablet breakpoint, and not on larger screens', () => {
    const css = read('product-detail.css');
    const media = css.match(/@media \(max-width: 47\.999rem\)\s*\{([\s\S]*?\})\s*\}/);
    expect(media, 'max-width: 47.999rem media block').not.toBeNull();
    expect(media[1]).toMatch(/\.product-detail__header h1\s*\{[^}]*font-size:\s*var\(--font-size-heading-section\)/);
    // The base rule itself keeps the default page-heading size.
    expect(rule(css, '.product-detail__header h1')).not.toMatch(/font-size/);
  });
});
