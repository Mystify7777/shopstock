import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import AppRoutes from './AppRoutes.jsx';
import { AuthSessionProvider } from './AuthSessionContext.jsx';
import { NAV_ITEMS } from './shell/navItems.js';

// Page bodies have their own tests; here they are stand-ins so THIS file
// can prove the application's routing boundary: which route renders
// what, that everything renders inside the shell, and that invalid
// destinations never produce a blank screen.
vi.mock('../pages/ProductListPage.jsx', async () => {
  const React = await import('react');
  return { default: () => React.createElement('h1', null, 'Products page') };
});
vi.mock('../pages/ProductDetailPage.jsx', async () => {
  const React = await import('react');
  const { useParams } = await import('react-router-dom');
  return {
    default: () => {
      const { id } = useParams();
      return React.createElement('h1', null, `Detail ${id}`);
    },
  };
});
vi.mock('../pages/ProductFormPage.jsx', async () => {
  const React = await import('react');
  const { useParams } = await import('react-router-dom');
  return {
    default: () => {
      const { id } = useParams();
      return React.createElement('h1', null, id ? `Edit ${id}` : 'New product');
    },
  };
});

const SESSION = {
  phase: 'authenticated',
  reason: null,
  loginOpen: false,
  openLogin: vi.fn(),
  closeLogin: vi.fn(),
  logout: vi.fn(),
};

function NavigationControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>history-back</button>
      <button onClick={() => navigate(1)}>history-forward</button>
    </>
  );
}

function renderAt(entries, { index, navItems } = {}) {
  const list = Array.isArray(entries) ? entries : [entries];
  return render(
    <MemoryRouter initialEntries={list} initialIndex={index ?? list.length - 1}>
      <AuthSessionProvider value={SESSION}>
        <AppRoutes navItems={navItems} />
      </AuthSessionProvider>
      <NavigationControls />
    </MemoryRouter>
  );
}

const main = () => screen.getByRole('main');

describe('AppRoutes composition', () => {
  describe('route inventory', () => {
    it('redirects / to the products list', () => {
      renderAt('/');
      expect(within(main()).getByRole('heading', { name: 'Products page' })).toBeInTheDocument();
    });

    it.each([
      ['/products', 'Products page'],
      ['/products/new', 'New product'],
      ['/products/abc', 'Detail abc'],
      ['/products/abc/edit', 'Edit abc'],
    ])('%s renders inside the shell content region', (path, heading) => {
      renderAt(path);
      expect(within(main()).getByRole('heading', { name: heading })).toBeInTheDocument();
    });
  });

  describe('shell frame', () => {
    it('provides banner, primary navigation, main, and the two mount points', () => {
      const { container } = renderAt('/products');
      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(container.querySelector('[data-shell-slot="notifications"]')).not.toBeNull();
      expect(container.querySelector('[data-shell-slot="sync-status"]')).not.toBeNull();
    });

    it('identifies the app and links home', () => {
      renderAt('/products/abc');
      expect(within(screen.getByRole('banner')).getByRole('link', { name: 'ShopStock' })).toHaveAttribute(
        'href',
        '/'
      );
    });

    it('the mount points are empty (real content is 7G)', () => {
      const { container } = renderAt('/products');
      expect(container.querySelector('[data-shell-slot="notifications"]')).toBeEmptyDOMElement();
      expect(container.querySelector('[data-shell-slot="sync-status"]')).toBeEmptyDOMElement();
    });

    it('renders exactly one page heading region per route (no duplicate frames)', () => {
      renderAt('/products/abc');
      expect(screen.getAllByRole('banner')).toHaveLength(1);
      expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('reserves the mobile bottom bar only when there are 2+ nav items', () => {
      const { container, unmount } = renderAt('/products');
      expect(container.querySelector('.app-shell').dataset.hasBottomBar).toBe('false');
      unmount();

      const { container: c2 } = renderAt('/products', {
        navItems: [
          { label: 'Dashboard', to: '/', end: true },
          { label: 'Products', to: '/products' },
        ],
      });
      expect(c2.querySelector('.app-shell').dataset.hasBottomBar).toBe('true');
    });
  });

  describe('active navigation', () => {
    it.each(['/products', '/products/new', '/products/abc', '/products/abc/edit'])(
      'Products is active at %s',
      (path) => {
        renderAt(path);
        expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('aria-current', 'page');
      }
    );
  });

  describe('no dead navigation', () => {
    it.each(NAV_ITEMS.map((i) => [i.label, i.to]))(
      'the "%s" nav destination (%s) resolves to a real page, not Not Found',
      (_label, to) => {
        renderAt(to);
        expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument();
      }
    );

    it('every nav link can be followed to a real page', () => {
      renderAt('/products/abc');
      for (const link of within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link')) {
        fireEvent.click(link);
        expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument();
        expect(main()).not.toBeEmptyDOMElement();
      }
    });
  });

  describe('unknown routes', () => {
    it.each(['/nope', '/products/abc/edit/extra', '/products/a/b/c/d', '/dashboard'])(
      '%s shows a real Not Found screen inside the shell',
      (path) => {
        renderAt(path);
        expect(within(main()).getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
        expect(within(main()).getByRole('alert')).toHaveTextContent("That page doesn't exist.");
        // shell (and therefore navigation) is still there: a safe exit
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      }
    );

    it('marks no navigation item active on Not Found', () => {
      renderAt('/nope');
      expect(screen.getByRole('link', { name: 'Products' })).not.toHaveAttribute('aria-current');
    });

    it('offers a link back to Products that works', () => {
      renderAt('/nope');
      fireEvent.click(within(main()).getByRole('link', { name: 'Back to Products' }));
      expect(within(main()).getByRole('heading', { name: 'Products page' })).toBeInTheDocument();
    });
  });

  describe('browser history', () => {
    it('back and forward move between routes', () => {
      renderAt(['/products', '/products/new'], { index: 1 });
      expect(within(main()).getByRole('heading', { name: 'New product' })).toBeInTheDocument();

      fireEvent.click(screen.getByText('history-back'));
      expect(within(main()).getByRole('heading', { name: 'Products page' })).toBeInTheDocument();

      fireEvent.click(screen.getByText('history-forward'));
      expect(within(main()).getByRole('heading', { name: 'New product' })).toBeInTheDocument();
    });

    it('the redirect from / replaces history (back does not bounce)', () => {
      renderAt(['/nope', '/'], { index: 1 });
      expect(within(main()).getByRole('heading', { name: 'Products page' })).toBeInTheDocument();
      fireEvent.click(screen.getByText('history-back'));
      expect(within(main()).getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    });
  });

  it('a direct load of a deep supported route works with no prior navigation', () => {
    renderAt('/products/xyz/edit');
    expect(within(main()).getByRole('heading', { name: 'Edit xyz' })).toBeInTheDocument();
  });
});
