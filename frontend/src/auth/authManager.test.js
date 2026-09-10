import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthManager, AUTH_STATUS } from './authManager.js';
import { AuthApiError, AuthNetworkError } from './authClient.js';

// ---------------------------------------------------------------------------
// Mock dependency factories
// ---------------------------------------------------------------------------

function makeMockSessionStore(initialRefreshToken = null) {
  let stored = initialRefreshToken;
  return {
    getRefreshToken: vi.fn(async () => stored),
    setRefreshToken: vi.fn(async (token) => {
      stored = token;
    }),
    clearRefreshToken: vi.fn(async () => {
      stored = null;
    }),
    // test-only helper, not part of the real sessionStore contract
    _peek: () => stored,
  };
}

function makeMockAuthClient() {
  return {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
  };
}

describe('authManager', () => {
  let sessionStore;
  let authClient;
  let manager;

  beforeEach(() => {
    sessionStore = makeMockSessionStore();
    authClient = makeMockAuthClient();
    manager = createAuthManager({ sessionStore, authClient });
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('createAuthManager', () => {
    it('throws if sessionStore is missing', () => {
      expect(() => createAuthManager({ authClient })).toThrow(TypeError);
    });

    it('throws if authClient is missing', () => {
      expect(() => createAuthManager({ sessionStore })).toThrow(TypeError);
    });
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts unauthenticated', () => {
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });

    it('starts with no access token in memory', () => {
      expect(manager.getAccessToken()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  describe('login', () => {
    it('installs the access token in memory on success', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');
      expect(manager.getAccessToken()).toBe('access-1');
    });

    it('transitions status to authenticated on success', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');
      expect(manager.getStatus()).toBe(AUTH_STATUS.AUTHENTICATED);
    });

    it('persists the refresh token via sessionStore', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');
      expect(sessionStore.setRefreshToken).toHaveBeenCalledWith('refresh-1');
    });

    it('calls authClient.login with the exact credentials passed in', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');
      expect(authClient.login).toHaveBeenCalledWith('shopowner', 'hunter2');
    });

    it('a successful second login replaces an existing session', async () => {
      authClient.login.mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.login.mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.login('shopowner', 'newpass');

      expect(manager.getAccessToken()).toBe('access-2');
      expect(sessionStore._peek()).toBe('refresh-2');
    });

    it('a failed login preserves an existing valid session untouched', async () => {
      authClient.login.mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.login.mockRejectedValueOnce(new AuthApiError('UNAUTHORIZED', 'Invalid credentials.', 401));
      await expect(manager.login('shopowner', 'wrongpass')).rejects.toBeInstanceOf(AuthApiError);

      expect(manager.getAccessToken()).toBe('access-1');
      expect(manager.getStatus()).toBe(AUTH_STATUS.AUTHENTICATED);
      expect(sessionStore._peek()).toBe('refresh-1');
    });

    it('a failed login from an unauthenticated state remains unauthenticated', async () => {
      authClient.login.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'Invalid credentials.', 401));
      await expect(manager.login('shopowner', 'wrongpass')).rejects.toBeInstanceOf(AuthApiError);
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
      expect(manager.getAccessToken()).toBeNull();
    });

    it('propagates AuthNetworkError without touching local state', async () => {
      authClient.login.mockRejectedValue(new AuthNetworkError(new Error('offline')));
      await expect(manager.login('shopowner', 'hunter2')).rejects.toBeInstanceOf(AuthNetworkError);
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });
  });

  // ---------------------------------------------------------------------------
  // Credential shape validation (of what sessionStore returns)
  // ---------------------------------------------------------------------------

  describe('credential validation on restoration', () => {
    it('treats a null persisted refresh token as nothing to restore', async () => {
      sessionStore.getRefreshToken.mockResolvedValue(null);
      await manager.restoreSession();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
      expect(authClient.refresh).not.toHaveBeenCalled();
    });

    it('treats a non-string persisted value as nothing to restore, without calling authClient.refresh', async () => {
      sessionStore.getRefreshToken.mockResolvedValue(12345);
      await manager.restoreSession();
      expect(authClient.refresh).not.toHaveBeenCalled();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });

    it('treats an empty-string persisted value as nothing to restore', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('');
      await manager.restoreSession();
      expect(authClient.refresh).not.toHaveBeenCalled();
    });

    it('a valid non-empty string persisted value is passed to authClient.refresh', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.restoreSession();
      expect(authClient.refresh).toHaveBeenCalledWith('refresh-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Startup restoration
  // ---------------------------------------------------------------------------

  describe('restoreSession', () => {
    it('installs the refreshed access token on success', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.restoreSession();
      expect(manager.getAccessToken()).toBe('access-2');
      expect(manager.getStatus()).toBe(AUTH_STATUS.AUTHENTICATED);
    });

    it('persists the new rotated refresh token, replacing the old one', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.restoreSession();
      expect(sessionStore._peek()).toBe('refresh-2');
    });

    it('does not modify domain data or touch anything beyond session state', async () => {
      // Verified structurally: the manager's dependencies are ONLY
      // sessionStore and authClient -- there is no domain/repository
      // reference anywhere for it to call, so "does not touch domain
      // data" is true by construction. This test documents that intent.
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.restoreSession();
      expect(Object.keys(manager)).toEqual([
        'getStatus', 'getAccessToken', 'login', 'restoreSession', 'refresh', 'logout',
      ]);
    });

    it('failed refresh (expired/revoked token) clears the persisted credential', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('stale-refresh-token');
      authClient.refresh.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'Invalid or expired refresh token.', 401));

      await expect(manager.restoreSession()).rejects.toBeInstanceOf(AuthApiError);

      expect(sessionStore.clearRefreshToken).toHaveBeenCalled();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
      expect(manager.getAccessToken()).toBeNull();
    });

    it('network failure during restoration does NOT clear the persisted credential', async () => {
      sessionStore = makeMockSessionStore('refresh-1');
      manager = createAuthManager({ sessionStore, authClient });
      authClient.refresh.mockRejectedValue(new AuthNetworkError(new Error('offline')));

      await expect(manager.restoreSession()).rejects.toBeInstanceOf(AuthNetworkError);

      expect(sessionStore.clearRefreshToken).not.toHaveBeenCalled();
      expect(sessionStore._peek()).toBe('refresh-1');
    });

    it('network failure during restoration leaves status unauthenticated but is distinguishable from an invalid-credential failure', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockRejectedValue(new AuthNetworkError(new Error('offline')));
      let caught;
      try {
        await manager.restoreSession();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AuthNetworkError);
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });

    it('persistence failure during credential installation does not report success', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      sessionStore.setRefreshToken.mockRejectedValue(new Error('IndexedDB write failed'));

      await expect(manager.restoreSession()).rejects.toThrow('IndexedDB write failed');

      // The access token must NOT be installed if persistence of the
      // paired refresh token failed -- otherwise memory would hold a
      // valid access token while IndexedDB still points at the now-dead
      // consumed refresh token, which is exactly the split state the
      // locked contract forbids.
      expect(manager.getAccessToken()).toBeNull();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });
  });

  // ---------------------------------------------------------------------------
  // Single-flight refresh
  // ---------------------------------------------------------------------------

  describe('single-flight refresh', () => {
    it('concurrent refresh() calls share exactly one authClient.refresh() invocation', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      let resolveRefresh;
      authClient.refresh.mockReturnValue(
        new Promise((resolve) => { resolveRefresh = resolve; })
      );

      const p1 = manager.refresh();
      const p2 = manager.refresh();
      const p3 = manager.refresh();

      resolveRefresh({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await Promise.all([p1, p2, p3]);

      expect(authClient.refresh).toHaveBeenCalledTimes(1);
    });

    it('all waiters receive the same resolved access token', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      let resolveRefresh;
      authClient.refresh.mockReturnValue(
        new Promise((resolve) => { resolveRefresh = resolve; })
      );

      const p1 = manager.refresh();
      const p2 = manager.refresh();

      resolveRefresh({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('access-2');
      expect(r2).toBe('access-2');
    });

    it('a failed single-flight refresh rejects all waiting callers', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      let rejectRefresh;
      authClient.refresh.mockReturnValue(
        new Promise((_, reject) => { rejectRefresh = reject; })
      );

      const p1 = manager.refresh();
      const p2 = manager.refresh();

      rejectRefresh(new AuthApiError('UNAUTHORIZED', 'Invalid refresh token.', 401));

      await expect(p1).rejects.toBeInstanceOf(AuthApiError);
      await expect(p2).rejects.toBeInstanceOf(AuthApiError);
    });

    it('only one refresh request consumes the current rotating refresh token', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      let resolveRefresh;
      authClient.refresh.mockReturnValue(
        new Promise((resolve) => { resolveRefresh = resolve; })
      );

      manager.refresh();
      manager.refresh();
      manager.refresh();

      resolveRefresh({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await Promise.resolve();
      await Promise.resolve();

      // Every concurrent call read the SAME persisted token
      // ('refresh-1') exactly once via the single in-flight attempt --
      // not once per caller.
      expect(authClient.refresh).toHaveBeenCalledWith('refresh-1');
      expect(authClient.refresh).toHaveBeenCalledTimes(1);
    });

    it('a subsequent refresh wave after a completed refresh gets a genuinely fresh attempt', async () => {
      sessionStore = makeMockSessionStore('refresh-1');
      manager = createAuthManager({ sessionStore, authClient });
      authClient.refresh.mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      await manager.refresh();

      authClient.refresh.mockResolvedValueOnce({ accessToken: 'access-3', refreshToken: 'refresh-3' });
      await manager.refresh();

      expect(authClient.refresh).toHaveBeenCalledTimes(2);
      // Second wave used the ROTATED token from the first wave, not the
      // original -- confirms sessionStore is re-read fresh per wave,
      // not cached from the first attempt.
      expect(authClient.refresh).toHaveBeenNthCalledWith(2, 'refresh-2');
    });

    it('a new refresh wave can start again after a failed wave completes', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.refresh.mockRejectedValueOnce(new AuthNetworkError(new Error('offline')));
      await expect(manager.refresh()).rejects.toBeInstanceOf(AuthNetworkError);

      authClient.refresh.mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      const token = await manager.refresh();

      expect(token).toBe('access-2');
      expect(authClient.refresh).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  describe('logout', () => {
    it('attempts server logout when a refresh token is persisted', async () => {
      sessionStore.getRefreshToken.mockResolvedValue('refresh-1');
      authClient.logout.mockResolvedValue(undefined);
      await manager.logout();
      expect(authClient.logout).toHaveBeenCalledWith('refresh-1');
    });

    it('does not attempt server logout when no refresh token is persisted', async () => {
      sessionStore.getRefreshToken.mockResolvedValue(null);
      await manager.logout();
      expect(authClient.logout).not.toHaveBeenCalled();
    });

    it('clears in-memory access token and status on successful logout', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.logout.mockResolvedValue(undefined);
      await manager.logout();

      expect(manager.getAccessToken()).toBeNull();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });

    it('clears the persisted refresh token on successful logout', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.logout.mockResolvedValue(undefined);
      await manager.logout();

      expect(sessionStore.clearRefreshToken).toHaveBeenCalled();
    });

    it('clears local credentials even when the server logout call fails', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.logout.mockRejectedValue(new AuthNetworkError(new Error('offline')));
      await manager.logout();

      expect(manager.getAccessToken()).toBeNull();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
      expect(sessionStore.clearRefreshToken).toHaveBeenCalled();
    });

    it('does not throw when the server logout call fails', async () => {
      authClient.login.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      await manager.login('shopowner', 'hunter2');

      authClient.logout.mockRejectedValue(new AuthNetworkError(new Error('offline')));
      await expect(manager.logout()).resolves.toBeUndefined();
    });

    it('logout does not require an access token to be present', async () => {
      // Already unauthenticated, no access token -- logout should still
      // safely no-op (no persisted refresh token either, in this case).
      sessionStore.getRefreshToken.mockResolvedValue(null);
      await expect(manager.logout()).resolves.toBeUndefined();
      expect(manager.getStatus()).toBe(AUTH_STATUS.UNAUTHENTICATED);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope boundary
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not expose any generic HTTP request method', () => {
      expect(manager.request).toBeUndefined();
      expect(manager.fetch).toBeUndefined();
    });

    it('does not expose Dexie/db internals', () => {
      expect(manager.db).toBeUndefined();
      expect(manager.session).toBeUndefined();
    });
  });
});
