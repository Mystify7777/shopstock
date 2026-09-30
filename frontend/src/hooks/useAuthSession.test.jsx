import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AppProvider } from '../contexts/AppContext.jsx';
import { createAuthManager } from '../auth/authManager.js';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';
import { useAuthSession, AUTH_PHASE, AUTH_REASON } from './useAuthSession.js';

// These tests use the REAL authManager (with mocked store/client) so the
// status-change notifications the hook depends on are genuinely exercised.

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

function makeAuthClient() {
  return { login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), changePassword: vi.fn() };
}

function setup({ persisted = null, authClientSetup } = {}) {
  const sessionStore = makeSessionStore(persisted);
  const authClient = makeAuthClient();
  authClientSetup?.(authClient);
  const authManager = createAuthManager({ sessionStore, authClient });
  const wrapper = ({ children }) => (
    <AppProvider services={{ authManager }}>{children}</AppProvider>
  );
  const view = renderHook(() => useAuthSession(), { wrapper });
  return { ...view, authManager, authClient, sessionStore };
}

const CREDS = { accessToken: 'access-1', refreshToken: 'refresh-1' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuthSession', () => {
  it('starts in restoring while a persisted session is being restored', async () => {
    const { result } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockReturnValue(new Promise(() => {})),
    });
    expect(result.current.phase).toBe(AUTH_PHASE.RESTORING);
  });

  it('goes authenticated when restoration succeeds', async () => {
    const { result } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));
    expect(result.current.reason).toBeNull();
  });

  it('shows plain login (no reason) when nothing is persisted', async () => {
    const { result, authClient } = setup();
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LOGIN));
    expect(result.current.reason).toBeNull();
    expect(authClient.refresh).not.toHaveBeenCalled();
  });

  it('shows login with an "expired" reason when the backend rejects the persisted session', async () => {
    const { result, sessionStore } = setup({
      persisted: 'r0',
      authClientSetup: (c) =>
        c.refresh.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'revoked', 401)),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LOGIN));
    expect(result.current.reason).toBe(AUTH_REASON.EXPIRED);
    expect(sessionStore._peek()).toBeNull();
  });

  it('treats a network failure as a trusted, offline (limited) session -- not a logout', async () => {
    const { result, sessionStore } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockRejectedValue(new AuthNetworkError(new Error('down'))),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LIMITED));
    expect(result.current.reason).toBe(AUTH_REASON.OFFLINE);
    expect(sessionStore._peek()).toBe('r0'); // credentials untouched
  });

  it('recovers from offline to authenticated when a later refresh succeeds', async () => {
    const { result, authManager, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockRejectedValue(new AuthNetworkError(new Error('down'))),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LIMITED));

    authClient.refresh.mockResolvedValue(CREDS);
    await act(async () => {
      await authManager.refresh();
    });
    expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED);
  });

  it('reports an unexpected restoration failure as login/restore-failed and logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockRejectedValue(new TypeError('idb exploded')),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LOGIN));
    expect(result.current.reason).toBe(AUTH_REASON.RESTORE_FAILED);
    expect(consoleError).toHaveBeenCalled();
  });

  it('starts authenticated (without restoring) when authManager is already authenticated', async () => {
    const sessionStore = makeSessionStore();
    const authClient = makeAuthClient();
    authClient.login.mockResolvedValue(CREDS);
    const authManager = createAuthManager({ sessionStore, authClient });
    await authManager.login('shop', 'pw');
    const restoreSpy = vi.spyOn(authManager, 'restoreSession');

    const { result } = renderHook(() => useAuthSession(), {
      wrapper: ({ children }) => <AppProvider services={{ authManager }}>{children}</AppProvider>,
    });
    expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED);
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('moves to limited/session-ended when a mid-use refresh is rejected', async () => {
    const { result, authManager, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));

    authClient.refresh.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'revoked', 401));
    await act(async () => {
      await expect(authManager.refresh()).rejects.toThrow(AuthApiError);
    });
    expect(result.current.phase).toBe(AUTH_PHASE.LIMITED);
    expect(result.current.reason).toBe(AUTH_REASON.SESSION_ENDED);
  });

  it('does NOT leave authenticated when a mid-use refresh fails only due to the network', async () => {
    const { result, authManager, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));

    authClient.refresh.mockRejectedValue(new AuthNetworkError(new Error('down')));
    await act(async () => {
      await expect(authManager.refresh()).rejects.toThrow(AuthNetworkError);
    });
    expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED);
  });

  it('logout clears credentials and goes to plain login (not session-ended)', async () => {
    const { result, sessionStore, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));

    authClient.logout.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.phase).toBe(AUTH_PHASE.LOGIN);
    expect(result.current.reason).toBeNull();
    expect(sessionStore._peek()).toBeNull();
  });

  it('an intentional logout never passes through the session-ended state', async () => {
    const { result, sessionStore, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));

    // Hold the persisted-token clear open: authManager has already flipped
    // to UNAUTHENTICATED and notified, but logout() has not finished.
    let releaseClear;
    sessionStore.clearRefreshToken.mockImplementation(
      () => new Promise((resolve) => (releaseClear = resolve))
    );
    authClient.logout.mockResolvedValue(undefined);

    let logoutPromise;
    await act(async () => {
      logoutPromise = result.current.logout();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Would be LIMITED/session-ended (flashing "You're signed out of the
    // server" at someone who just chose to sign out) without the guard.
    expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED);

    await act(async () => {
      releaseClear();
      await logoutPromise;
    });
    expect(result.current.phase).toBe(AUTH_PHASE.LOGIN);
  });

  it('logout still lands on login when the server call fails', async () => {
    const { result, authClient } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockResolvedValue(CREDS),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED));

    authClient.logout.mockRejectedValue(new AuthNetworkError(new Error('down')));
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.phase).toBe(AUTH_PHASE.LOGIN);
  });

  it('a successful login (via authManager) moves login -> authenticated and closes the login overlay', async () => {
    const { result, authManager, authClient } = setup();
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LOGIN));

    authClient.login.mockResolvedValue(CREDS);
    await act(async () => {
      await authManager.login('shop', 'pw');
    });
    expect(result.current.phase).toBe(AUTH_PHASE.AUTHENTICATED);
    expect(result.current.loginOpen).toBe(false);
  });

  it('openLogin/closeLogin toggle loginOpen', async () => {
    const { result } = setup({
      persisted: 'r0',
      authClientSetup: (c) => c.refresh.mockRejectedValue(new AuthNetworkError(new Error('down'))),
    });
    await waitFor(() => expect(result.current.phase).toBe(AUTH_PHASE.LIMITED));

    act(() => result.current.openLogin());
    expect(result.current.loginOpen).toBe(true);
    act(() => result.current.closeLogin());
    expect(result.current.loginOpen).toBe(false);
  });

  it('unsubscribes from authManager on unmount', async () => {
    const sessionStore = makeSessionStore();
    const authClient = makeAuthClient();
    const authManager = createAuthManager({ sessionStore, authClient });
    const unsubscribe = vi.fn();
    vi.spyOn(authManager, 'subscribe').mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useAuthSession(), {
      wrapper: ({ children }) => <AppProvider services={{ authManager }}>{children}</AppProvider>,
    });
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
