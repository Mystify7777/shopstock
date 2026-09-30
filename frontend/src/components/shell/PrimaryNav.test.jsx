import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PrimaryNav from './PrimaryNav.jsx';
import { NAV_ITEMS, MOBILE_BAR_MIN_ITEMS } from './navItems.js';

function renderAt(path, items) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PrimaryNav items={items} />
    </MemoryRouter>
  );
}

const current = (name) => screen.getByRole('link', { name }).getAttribute('aria-current');

describe('navItems', () => {
  it('contains only real, absolute destinations', () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(0);
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy();
      expect(item.to.startsWith('/')).toBe(true);
    }
  });

  it('has unique destinations', () => {
    const targets = NAV_ITEMS.map((i) => i.to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('PrimaryNav', () => {
  it('is a labelled navigation landmark with one link per item', () => {
    renderAt('/products');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
  });

  it.each(['/products', '/products/new', '/products/abc', '/products/abc/edit'])(
    'marks Products active at %s',
    (path) => {
      renderAt(path);
      expect(current('Products')).toBe('page');
    }
  );

  it('marks nothing active on an unknown route', () => {
    renderAt('/nope');
    expect(current('Products')).toBeNull();
  });

  it('does not treat a merely similar path as active (segment boundary)', () => {
    renderAt('/products-archive');
    expect(current('Products')).toBeNull();
  });

  describe('with several items', () => {
    const items = [
      { label: 'Dashboard', to: '/', end: true },
      { label: 'Products', to: '/products' },
    ];

    it('an `end` item at "/" is active only on exactly "/"', () => {
      renderAt('/', items);
      expect(current('Dashboard')).toBe('page');
      expect(current('Products')).toBeNull();
    });

    it('an `end` item at "/" is NOT active on other routes', () => {
      renderAt('/products/abc', items);
      expect(current('Dashboard')).toBeNull();
      expect(current('Products')).toBe('page');
    });
  });

  describe('mobile bottom bar rule', () => {
    it('is off with a single item', () => {
      const { container } = renderAt('/products', [{ label: 'Products', to: '/products' }]);
      expect(container.querySelector('nav').dataset.mobileBar).toBe('false');
    });

    it(`is on from ${MOBILE_BAR_MIN_ITEMS} items`, () => {
      const { container } = renderAt('/products', [
        { label: 'Dashboard', to: '/', end: true },
        { label: 'Products', to: '/products' },
      ]);
      expect(container.querySelector('nav').dataset.mobileBar).toBe('true');
    });
  });
});
