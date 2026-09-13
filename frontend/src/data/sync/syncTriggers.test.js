import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triggerStartupSync, registerConnectivitySyncTrigger } from './syncTriggers.js';
import { AUTH_STATUS } from '../../auth/authManager.js';
import { AuthApiError, AuthNetworkError } from '../../auth/authClient.js';

function makeMockAuthManager(finalStatus = AUTH_STATUS.UNAUTHENTICATED) {
  return {
    restoreSession: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => finalStatus),
  };
}

function makeMockSyncDrainer() {
  return {
    drain: vi.fn().mockResolvedValue({ processed: 0, failed: 0, stopped: false, reason: null }),
  };
}

describe('triggerStartupSync', () => {
  it('drains when restoreSession resolves and status becomes AUTHENTICATED', async () => {
    const authManager = makeMockAuthManager(AUTH_STATUS.AUTHENTICATED);
    const syncDrainer = makeMockSyncDrainer();

    await triggerStartupSync({ authManager, syncDrainer });

    expect(syncDrainer.drain).toHaveBeenCalledTimes(1);
  });

  it('does NOT drain when restoreSession resolves but status remains UNAUTHENTICATED (no persisted token)', async () => {
    const authManager = makeMockAuthManager(AUTH_STATUS.UNAUTHENTICATED);
    const syncDrainer = makeMockSyncDrainer();

    await triggerStartupSync({ authManager, syncDrainer });

    expect(syncDrainer.drain).not.toHaveBeenCalled();
  });

  it('does NOT drain when restoreSession throws AuthApiError (invalid/expired token)', async () => {
    const authManager = makeMockAuthManager(AUTH_STATUS.UNAUTHENTICATED);
    authManager.restoreSession.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'Refresh token expired.', 401));
    const syncDrainer = makeMockSyncDrainer();

    await triggerStartupSync({ authManager, syncDrainer });

    expect(syncDrainer.drain).not.toHaveBeenCalled();
  });

  it('does NOT drain when restoreSession throws AuthNetworkError (offline)', async () => {
    const authManager = makeMockAuthManager(AUTH_STATUS.UNAUTHENTICATED);
    authManager.restoreSession.mockRejectedValue(new AuthNetworkError(new Error('offline')));
    const syncDrainer = makeMockSyncDrainer();

    await triggerStartupSync({ authManager, syncDrainer });

    expect(syncDrainer.drain).not.toHaveBeenCalled();
  });

  it('does not throw itself for the expected AuthNetworkError case', async () => {
    const authManager = makeMockAuthManager();
    authManager.restoreSession.mockRejectedValue(new AuthNetworkError(new Error('offline')));
    const syncDrainer = makeMockSyncDrainer();

    await expect(triggerStartupSync({ authManager, syncDrainer })).resolves.toBeUndefined();
  });

  it('does not throw itself for the expected AuthApiError case', async () => {
    const authManager = makeMockAuthManager();
    authManager.restoreSession.mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'x', 401));
    const syncDrainer = makeMockSyncDrainer();

    await expect(triggerStartupSync({ authManager, syncDrainer })).resolves.toBeUndefined();
  });

  it('propagates an unexpected error rather than silently swallowing it', async () => {
    // A genuine programming defect somewhere in the restore path --
    // NOT one of the two expected auth-restoration failure types. Must
    // not be treated the same as "no session to restore."
    const authManager = makeMockAuthManager();
    const bug = new TypeError('something unrelated broke');
    authManager.restoreSession.mockRejectedValue(bug);
    const syncDrainer = makeMockSyncDrainer();

    await expect(triggerStartupSync({ authManager, syncDrainer })).rejects.toBe(bug);
  });

  it('does not attempt to drain when an unexpected error is thrown', async () => {
    const authManager = makeMockAuthManager();
    authManager.restoreSession.mockRejectedValue(new TypeError('boom'));
    const syncDrainer = makeMockSyncDrainer();

    await expect(triggerStartupSync({ authManager, syncDrainer })).rejects.toThrow();
    expect(syncDrainer.drain).not.toHaveBeenCalled();
  });

  it('checks status only after restoreSession has actually resolved (correct ordering)', async () => {
    const callOrder = [];
    const authManager = {
      restoreSession: vi.fn(async () => { callOrder.push('restoreSession'); }),
      getStatus: vi.fn(() => { callOrder.push('getStatus'); return AUTH_STATUS.AUTHENTICATED; }),
    };
    const syncDrainer = makeMockSyncDrainer();

    await triggerStartupSync({ authManager, syncDrainer });

    expect(callOrder).toEqual(['restoreSession', 'getStatus']);
  });

  it('does not inspect or reinterpret the DrainResult -- only calls drain()', async () => {
    const authManager = makeMockAuthManager(AUTH_STATUS.AUTHENTICATED);
    const syncDrainer = {
      drain: vi.fn().mockResolvedValue({ processed: 3, failed: 1, stopped: true, reason: 'authError' }),
    };

    // Should resolve cleanly regardless of what drain() reports --
    // this module has no policy for interpreting the result.
    await expect(triggerStartupSync({ authManager, syncDrainer })).resolves.toBeUndefined();
    expect(syncDrainer.drain).toHaveBeenCalledTimes(1);
  });
});

describe('registerConnectivitySyncTrigger', () => {
  let originalAddEventListener;
  let originalRemoveEventListener;

  beforeEach(() => {
    originalAddEventListener = window.addEventListener;
    originalRemoveEventListener = window.removeEventListener;
  });

  afterEach(() => {
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
    vi.restoreAllMocks();
  });

  it('registers exactly one "online" listener', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const syncDrainer = makeMockSyncDrainer();

    registerConnectivitySyncTrigger({ syncDrainer });

    const onlineCalls = addSpy.mock.calls.filter(([event]) => event === 'online');
    expect(onlineCalls).toHaveLength(1);
  });

  it('calls syncDrainer.drain() directly, with no gating, when online fires', () => {
    const syncDrainer = makeMockSyncDrainer();
    registerConnectivitySyncTrigger({ syncDrainer });

    window.dispatchEvent(new Event('online'));

    expect(syncDrainer.drain).toHaveBeenCalledTimes(1);
  });

  it('calls drain() again on a second online event', () => {
    const syncDrainer = makeMockSyncDrainer();
    registerConnectivitySyncTrigger({ syncDrainer });

    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));

    expect(syncDrainer.drain).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const syncDrainer = makeMockSyncDrainer();
    const unsubscribe = registerConnectivitySyncTrigger({ syncDrainer });

    unsubscribe();
    window.dispatchEvent(new Event('online'));

    expect(syncDrainer.drain).not.toHaveBeenCalled();
  });

  it('does not throw synchronously even if drain() rejects', () => {
    const syncDrainer = { drain: vi.fn().mockRejectedValue(new Error('unexpected')) };
    registerConnectivitySyncTrigger({ syncDrainer });

    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
  });
});
