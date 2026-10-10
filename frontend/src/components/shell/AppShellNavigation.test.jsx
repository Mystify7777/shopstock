import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import AppShell from './AppShell.jsx';
import { AppProvider } from '../../contexts/AppContext.jsx';
import { AuthSessionProvider } from '../AuthSessionContext.jsx';
import LoginPage from '../../pages/LoginPage.jsx';

// Shell-level navigation semantics (Phase 7H): skip link, document titles,
// the route announcer, and focus rescue. Pages are stand-ins.

const SESSION = {
  phase: 'authenticated',
  reason: null,
  loginOpen: false,
  openLogin: vi.fn(),
  closeLogin: vi.fn(),
  logout: vi.fn()
};

const IDLE_SYNC_STATUS = {
  observeSyncStatus: (onChange) => {
    onChange({ pendingCount: 0, failedCount: 0 });
    return () => {};
  }
};

// A page whose control goes away on navigation, like a saved form button.
function SavePage() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Add</h1>
      <button type="button" onClick={() => navigate('/products/p1')}>
        Save
      </button>
    </>
  );
}

function ListPage() {
  return (
    <>
      <h1>List</h1>
      <Link to="/products/a">Product A</Link>
      <Link to="/products/b">Product B</Link>
      <Link to="/products?stockStatus=low">Low stock only</Link>
      <Link to="/products#section">Jump</Link>
    </>
  );
}

function DetailPage() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Detail</h1>
      <Link to="/products/b">Next product</Link>
      <button type="button" onClick={() => navigate(-1)}>
        history-back
      </button>
    </>
  );
}

function renderShell(path = '/products') {
  return render(
    <AppProvider services={{ syncStatus: IDLE_SYNC_STATUS }}>
      <AuthSessionProvider value={SESSION}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<h1>Home</h1>} />
              <Route path="/products" element={<ListPage />} />
              <Route path="/products/new" element={<SavePage />} />
              <Route path="/products/:id" element={<DetailPage />} />
              <Route path="*" element={<h1>Missing</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthSessionProvider>
    </AppProvider>
  );
}

const announcer = (container) => container.querySelector('[data-shell-slot="route-announcer"]');

beforeEach(() => {
  document.title = 'before';
  // Start every test with focus on the page, not on a leftover element.
  document.body.focus();
});

describe('skip link', () => {
  it('is the first focusable element in the document and targets <main>', () => {
    const { container } = renderShell();
    const focusable = container.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(focusable[0]).toBe(skip);
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('<main> is a programmatic focus target only (not in the tab order)', () => {
    renderShell();
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('activating it moves focus to <main> and does not follow the hash', () => {
    renderShell();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    skip.focus();
    const notPrevented = fireEvent.click(skip);
    expect(notPrevented).toBe(false); // default prevented: no hash navigation
    expect(screen.getByRole('main')).toHaveFocus();
  });
});

describe('document title', () => {
  it('is set for the initial route', () => {
    renderShell('/products');
    expect(document.title).toBe('Products \u2014 ShopStock');
  });

  it.each([
    ['/', 'Dashboard \u2014 ShopStock'],
    ['/products/new', 'Add Product \u2014 ShopStock'],
    ['/products/p9', 'Product \u2014 ShopStock'],
    ['/nope', 'Page not found \u2014 ShopStock']
  ])('%s -> %s', (path, title) => {
    renderShell(path);
    expect(document.title).toBe(title);
  });

  it('follows client-side navigation', () => {
    renderShell('/products');
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(document.title).toBe('Product \u2014 ShopStock');
  });
});

describe('route announcer', () => {
  it('is a persistent polite live region, empty on first load', () => {
    const { container } = renderShell();
    const region = announcer(container);
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toBeEmptyDOMElement();
  });

  it('announces the new route after navigation', () => {
    const { container } = renderShell('/products');
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(announcer(container)).toHaveTextContent('Product');
  });

  it('announces again when consecutive routes share a name (product A -> product B)', () => {
    const { container } = renderShell('/products');
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    const first = announcer(container).firstElementChild;
    expect(first).toHaveTextContent('Product');

    fireEvent.click(screen.getByRole('link', { name: 'Next product' }));
    const second = announcer(container).firstElementChild;
    expect(second).toHaveTextContent('Product');
    // A fresh node is what makes a live region announce an identical text.
    expect(second).not.toBe(first);
  });

  it('does not announce a search-string or hash-only change', () => {
    const { container } = renderShell('/products');
    fireEvent.click(screen.getByRole('link', { name: 'Low stock only' }));
    expect(announcer(container)).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('link', { name: 'Jump' }));
    expect(announcer(container)).toBeEmptyDOMElement();
  });
});

describe('focus rescue after navigation', () => {
  it('moves focus to <main> when the focused control left the page (saved form)', () => {
    renderShell('/products/new');
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    expect(save).toHaveFocus();

    fireEvent.click(save);

    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('moves focus to <main> when an activated list link unmounts with its page', () => {
    renderShell('/products');
    const link = screen.getByRole('link', { name: 'Product A' });
    link.focus();
    fireEvent.click(link);
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('leaves focus alone when it is still on a real control (primary navigation link)', () => {
    renderShell('/products');
    // ShopStock brand link persists across routes, like a nav link.
    const brand = screen.getByRole('link', { name: 'ShopStock' });
    brand.focus();
    fireEvent.click(brand);
    expect(screen.getByRole('main')).not.toHaveFocus();
    expect(brand).toHaveFocus();
  });

  it('does not steal focus on the initial load', () => {
    renderShell('/products');
    expect(screen.getByRole('main')).not.toHaveFocus();
  });

  it('does not move focus for a search-string or hash-only change', () => {
    renderShell('/products');
    const link = screen.getByRole('link', { name: 'Low stock only' });
    link.focus();
    fireEvent.click(link);
    expect(link).toHaveFocus();
    expect(screen.getByRole('main')).not.toHaveFocus();
  });
});

describe.each([
  ['normal render', false],
  ['React StrictMode', true]
])('document title ownership with the sign-in overlay (regression), %s', (_mode, strict) => {
  // AuthGate keeps the app mounted underneath the login screen in the
  // `limited` phase, so a route change can happen while it is open.
  function renderWithOverlay(path = '/products') {
    const services = {
      syncStatus: IDLE_SYNC_STATUS,
      authManager: { login: vi.fn() },
      syncDrainer: { drain: vi.fn() }
    };
    function Harness({ overlayOpen }) {
      return (
        <AppProvider services={services}>
          <AuthSessionProvider value={SESSION}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/products" element={<ListPage />} />
                  <Route path="/products/:id" element={<DetailPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </AuthSessionProvider>
          {overlayOpen && <LoginPage />}
        </AppProvider>
      );
    }
    const wrap = (overlayOpen) =>
      strict ? (
        <StrictMode>
          <Harness overlayOpen={overlayOpen} />
        </StrictMode>
      ) : (
        <Harness overlayOpen={overlayOpen} />
      );
    const view = render(wrap(false));
    return {
      open: () => view.rerender(wrap(true)),
      close: () => view.rerender(wrap(false)),
      unmount: () => view.unmount()
    };
  }

  it('the overlay keeps the title while open, even when the route changes behind it', () => {
    const { open } = renderWithOverlay('/products');
    expect(document.title).toBe('Products \u2014 ShopStock');

    open();
    expect(document.title).toBe('Sign in \u2014 ShopStock');

    // A client-side route change behind the overlay (a link click).
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(document.title).toBe('Sign in \u2014 ShopStock');
  });

  it('closing the overlay reveals the CURRENT route title, not the one from when it opened', () => {
    const { open, close } = renderWithOverlay('/products');
    open();
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));

    close();
    expect(document.title).toBe('Product \u2014 ShopStock');
    expect(document.title).not.toBe('Products \u2014 ShopStock'); // the stale one
  });

  it('history navigation (back) behind the overlay does not take the title either', () => {
    const { open, close } = renderWithOverlay('/products');
    // Build history before the overlay opens: /products -> /products/a
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(document.title).toBe('Product \u2014 ShopStock');

    open();
    expect(document.title).toBe('Sign in \u2014 ShopStock');

    // Router history back, the way Back works in the real app.
    fireEvent.click(screen.getByRole('button', { name: 'history-back' }));
    expect(document.title).toBe('Sign in \u2014 ShopStock');

    close();
    expect(document.title).toBe('Products \u2014 ShopStock'); // the route we went BACK to
  });

  it('a route change after the overlay has closed updates the title normally', () => {
    const { open, close } = renderWithOverlay('/products');
    open();
    close();
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(document.title).toBe('Product \u2014 ShopStock');
  });
});

describe('under React StrictMode (effects mount, clean up and mount again)', () => {
  function renderStrictShell(path = '/products') {
    return render(
      <StrictMode>
        <AppProvider services={{ syncStatus: IDLE_SYNC_STATUS }}>
          <AuthSessionProvider value={SESSION}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/products" element={<ListPage />} />
                  <Route path="/products/:id" element={<DetailPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </AuthSessionProvider>
        </AppProvider>
      </StrictMode>
    );
  }

  it('sets the route title once, with no announcement and no focus steal on first load', () => {
    const { container } = renderStrictShell('/products');
    expect(document.title).toBe('Products \u2014 ShopStock');
    expect(announcer(container)).toBeEmptyDOMElement();
    expect(screen.getByRole('main')).not.toHaveFocus();
  });

  it('navigation still announces exactly one fresh message and updates the title', () => {
    const { container } = renderStrictShell('/products');
    fireEvent.click(screen.getByRole('link', { name: 'Product A' }));
    expect(document.title).toBe('Product \u2014 ShopStock');
    expect(announcer(container).children).toHaveLength(1);
    expect(announcer(container)).toHaveTextContent('Product');
  });

  it('unmounting releases the title back to the original', () => {
    const view = renderStrictShell('/products');
    expect(document.title).toBe('Products \u2014 ShopStock');
    view.unmount();
    expect(document.title).toBe('before');
  });
});
