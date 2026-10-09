import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import { createAuthManager } from '../auth/authManager.js';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';
import AuthGate from './AuthGate.jsx';
import AppRoutes from './AppRoutes.jsx';

// Full composition: real router + real authManager + real AuthGate +
// real shell + real route table. Only the page BODIES are stand-ins (they
// have their own tests).
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
  return { default: () => React.createElement('h1', null, 'Form page') };
});

const CREDS = { accessToken: 'access-1', refreshToken: 'refresh-1' };

function makeSessionStore(initial = null) {
  let stored = initial;
  return {
    getRefreshToken: vi.fn(async () => stored),
    setRefreshToken: vi.fn(async (t) => {
      stored = t;
    }),
    clearRefreshToken: vi.fn(async () => {
      stored = null;
    }),
    _peek: () => stored,
  };
}

function mount({ persisted = null, refresh, path = '/products/abc' } = {}) {
  const sessionStore = makeSessionStore(persisted);
  const authClient = {
    login: vi.fn().mockResolvedValue(CREDS),
    refresh: refresh ?? vi.fn().mockResolvedValue(CREDS),
    logout: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn(),
  };
  const authManager = createAuthManager({ sessionStore, authClient });
  const syncDrainer = { drain: vi.fn().mockResolvedValue(undefined) };
  // The shell's sync indicator observes the queue; here: nothing to report.
  const syncStatus = {
    observeSyncStatus: (onChange) => {
      onChange({ pendingCount: 0, failedCount: 0 });
      return () => {};
    },
  };

  render(
    <AppProvider services={{ authManager, syncDrainer, syncStatus }}>
      <MemoryRouter initialEntries={[path]}>
        <AuthGate>
          <AppRoutes />
        </AuthGate>
      </MemoryRouter>
    </AppProvider>
  );
  return { authManager, authClient, sessionStore, syncDrainer };
}

afterEach(() => vi.restoreAllMocks());

describe('AuthGate + shell composition', () => {
  describe('startup', () => {
    it('shows a loading state (not the login form) while restoring', () => {
      mount({ persisted: 'r0', refresh: vi.fn(() => new Promise(() => {})) });
      expect(screen.getByRole('status')).toHaveTextContent('Loading ShopStock');
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    });

    it('enters the app at the requested URL once restoration succeeds', async () => {
      mount({ persisted: 'r0' });
      expect(await screen.findByRole('heading', { name: 'Detail abc' })).toBeInTheDocument();
      expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('shows the login screen when there is no session, with no app content', async () => {
      mount();
      expect(await screen.findByRole('heading', { name: 'Sign in to ShopStock' })).toBeInTheDocument();
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Detail abc' })).not.toBeInTheDocument();
    });

    it('shows login with an explanation when the saved session was rejected', async () => {
      mount({
        persisted: 'r0',
        refresh: vi.fn().mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'revoked', 401)),
      });
      expect(await screen.findByText('Your session expired. Sign in again.')).toBeInTheDocument();
    });

    it('lets a trusted device work offline: app + notice, no login wall', async () => {
      mount({
        persisted: 'r0',
        refresh: vi.fn().mockRejectedValue(new AuthNetworkError(new Error('down'))),
      });
      expect(await screen.findByRole('heading', { name: 'Detail abc' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/can.t reach the server/i);
      expect(screen.getByRole('status')).toHaveTextContent(/data saved on this device/i);
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });
  });

  describe('logging in', () => {
    it('signs in, drains the queue, and lands on the URL that was requested', async () => {
      const { authClient, syncDrainer } = mount({ path: '/products/abc' });
      await screen.findByRole('heading', { name: 'Sign in to ShopStock' });

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'shop' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('heading', { name: 'Detail abc' })).toBeInTheDocument();
      expect(authClient.login).toHaveBeenCalledWith('shop', 'pw');
      expect(syncDrainer.drain).toHaveBeenCalledTimes(1);
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    });

    it('stays on the login screen with a message after wrong credentials', async () => {
      const { authClient } = mount();
      authClient.login.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'bad', 401));
      await screen.findByRole('heading', { name: 'Sign in to ShopStock' });

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'shop' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.');
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    });
  });

  describe('logging out', () => {
    it('clears credentials and returns to login, without touching local data', async () => {
      const { sessionStore, authClient } = mount({ persisted: 'r0' });
      fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

      expect(await screen.findByRole('heading', { name: 'Sign in to ShopStock' })).toBeInTheDocument();
      expect(sessionStore._peek()).toBeNull();
      expect(authClient.logout).toHaveBeenCalled();
      // plain login: logging out is not "session lost"
      expect(screen.queryByText(/signed out of the server/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    });
  });

  describe('auth failure during use', () => {
    async function loseSession() {
      const ctx = mount({ persisted: 'r0' });
      await screen.findByRole('heading', { name: 'Detail abc' });
      ctx.authClient.refresh.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'revoked', 401));
      await act(async () => {
        await expect(ctx.authManager.refresh()).rejects.toThrow(AuthApiError);
      });
      return ctx;
    }

    it('keeps the app and local content, and explains that syncing needs a new sign-in', async () => {
      await loseSession();

      expect(screen.getByRole('heading', { name: 'Detail abc' })).toBeVisible();
      const notice = screen.getByRole('status');
      expect(notice).toHaveTextContent(/signed out of the server/i);
      expect(notice).toHaveTextContent(/data on this device is safe/i);
      expect(within(notice).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      // no duplicate sign-in/out controls in the header
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    });

    it('can sign in again from the notice, ending back in the app on the same page', async () => {
      const { authClient, syncDrainer } = await loseSession();

      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(screen.getByRole('heading', { name: 'Sign in to ShopStock' })).toBeInTheDocument();
      // app is kept mounted but hidden while signing in
      expect(screen.getByText('Detail abc')).not.toBeVisible();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'shop' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Detail abc' })).toBeVisible());
      expect(authClient.login).toHaveBeenCalled();
      expect(syncDrainer.drain).toHaveBeenCalled();
      expect(screen.queryByText(/signed out of the server/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });

    it('can dismiss the sign-in screen and keep working locally', async () => {
      await loseSession();

      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      fireEvent.click(screen.getByRole('button', { name: /continue without signing in/i }));

      expect(screen.getByRole('heading', { name: 'Detail abc' })).toBeVisible();
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
      expect(screen.getByText(/signed out of the server/i)).toBeInTheDocument();
    });
  });
});
