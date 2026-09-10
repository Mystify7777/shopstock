import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, ApiRequestError, ApiNetworkError } from './apiClient.js';
import { AuthApiError, AuthNetworkError } from './authClient.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockAuthManager(initialAccessToken = null) {
  let accessToken = initialAccessToken;
  return {
    getAccessToken: vi.fn(() => accessToken),
    refresh: vi.fn(async () => {
      accessToken = 'refreshed-access-token';
      return accessToken;
    }),
    // test-only helper
    _setAccessToken: (token) => { accessToken = token; },
  };
}

function mockFetchSequence(...responses) {
  const fn = vi.fn();
  for (const { status, body } of responses) {
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  }
  global.fetch = fn;
}

function mockFetchNetworkFailure() {
  global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
}

describe('apiClient', () => {
  const BASE_URL = 'https://api.example.com';

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('createApiClient', () => {
    it('throws if authManager is missing', () => {
      expect(() => createApiClient({ baseUrl: BASE_URL })).toThrow(TypeError);
    });

    it('throws if baseUrl is not a string', () => {
      const authManager = makeMockAuthManager();
      expect(() => createApiClient({ authManager })).toThrow(TypeError);
    });

    it('accepts an empty string baseUrl', () => {
      const authManager = makeMockAuthManager();
      expect(() => createApiClient({ authManager, baseUrl: '' })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Token attachment
  // ---------------------------------------------------------------------------

  describe('access token attachment', () => {
    it('attaches the current access token as a Bearer header when authenticated', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 200, body: { ok: true } });

      await client.request({ method: 'GET', path: '/api/products' });

      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBe('Bearer access-1');
    });

    it('attaches no Authorization header at all when unauthenticated', async () => {
      const authManager = makeMockAuthManager(null);
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 200, body: { ok: true } });

      await client.request({ method: 'GET', path: '/api/products' });

      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBeUndefined();
    });

    it('sends the exact method/path/body given', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 200, body: { ok: true } });

      await client.request({ method: 'PUT', path: '/api/products/prod-1', body: { name: 'Parle-G' } });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/products/prod-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ name: 'Parle-G' }),
        })
      );
    });

    it('returns the parsed response body on success', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 200, body: { id: 'prod-1', name: 'Parle-G' } });

      const result = await client.request({ method: 'GET', path: '/api/products/prod-1' });
      expect(result).toEqual({ id: 'prod-1', name: 'Parle-G' });
    });
  });

  // ---------------------------------------------------------------------------
  // Non-401 errors — no refresh triggered
  // ---------------------------------------------------------------------------

  describe('non-401 error responses', () => {
    it('a 400 response throws ApiRequestError without triggering a refresh', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Bad request.' } } });

      await expect(client.request({ method: 'PUT', path: '/api/products/prod-1' }))
        .rejects.toMatchObject({ name: 'ApiRequestError', code: 'VALIDATION_ERROR', status: 400 });
      expect(authManager.refresh).not.toHaveBeenCalled();
    });

    it('a 409 response throws ApiRequestError preserving the backend code', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 409, body: { error: { code: 'QUANTITY_CONSISTENCY_CONFLICT', message: 'Stale quantity.' } } });

      await expect(client.request({ method: 'PUT', path: '/api/stock-events/evt-1' }))
        .rejects.toMatchObject({ code: 'QUANTITY_CONSISTENCY_CONFLICT', status: 409 });
    });

    it('a 500 response throws ApiRequestError', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } } });

      await expect(client.request({ method: 'GET', path: '/api/products' }))
        .rejects.toBeInstanceOf(ApiRequestError);
    });

    it('falls back to a generic code/message when the error envelope is malformed', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence({ status: 500, body: {} });

      await expect(client.request({ method: 'GET', path: '/api/products' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_ERROR' });
    });
  });

  // ---------------------------------------------------------------------------
  // Network failure — distinct from 401 / auth failure
  // ---------------------------------------------------------------------------

  describe('network failure', () => {
    it('throws ApiNetworkError, not ApiRequestError, on a transport failure', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchNetworkFailure();

      await expect(client.request({ method: 'GET', path: '/api/products' }))
        .rejects.toBeInstanceOf(ApiNetworkError);
    });

    it('does not trigger a refresh on a network failure', async () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchNetworkFailure();

      await expect(client.request({ method: 'GET', path: '/api/products' })).rejects.toThrow();
      expect(authManager.refresh).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 401 recovery — the mandatory refresh/retry contract
  // ---------------------------------------------------------------------------

  describe('401 recovery', () => {
    it('a 401 triggers exactly one refresh', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 200, body: { id: 'prod-1' } }
      );

      await client.request({ method: 'GET', path: '/api/products/prod-1' });
      expect(authManager.refresh).toHaveBeenCalledTimes(1);
    });

    it('successful refresh retries the original request exactly once', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 200, body: { id: 'prod-1' } }
      );

      await client.request({ method: 'GET', path: '/api/products/prod-1' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('the retried request uses the NEW access token from the refresh', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 200, body: { id: 'prod-1' } }
      );

      await client.request({ method: 'GET', path: '/api/products/prod-1' });

      const [, secondRequestInit] = global.fetch.mock.calls[1];
      expect(secondRequestInit.headers.Authorization).toBe('Bearer refreshed-access-token');
    });

    it('a successful retry returns the retried response body', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 200, body: { id: 'prod-1', name: 'Parle-G' } }
      );

      const result = await client.request({ method: 'GET', path: '/api/products/prod-1' });
      expect(result).toEqual({ id: 'prod-1', name: 'Parle-G' });
    });

    it('a second 401 on the retried request does NOT trigger another refresh', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Still unauthorized.' } } }
      );

      await expect(client.request({ method: 'GET', path: '/api/products/prod-1' }))
        .rejects.toBeInstanceOf(ApiRequestError);
      expect(authManager.refresh).toHaveBeenCalledTimes(1);
    });

    it('a second 401 on the retried request surfaces as ApiRequestError, not a silent failure', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Still unauthorized.' } } }
      );

      await expect(client.request({ method: 'GET', path: '/api/products/prod-1' }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    });

    it('exactly two fetch calls total, never a third, when the retry also fails', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Still unauthorized.' } } }
      );

      await expect(client.request({ method: 'GET', path: '/api/products/prod-1' })).rejects.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('a failed refresh (expired refresh token) propagates the AuthApiError as-is', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      authManager.refresh = vi.fn().mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'Refresh token expired.', 401));
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } }
      );

      await expect(client.request({ method: 'GET', path: '/api/products/prod-1' }))
        .rejects.toBeInstanceOf(AuthApiError);
      // Only the first request was ever attempted -- refresh failed
      // before any retry could happen.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('a network failure during the refresh attempt propagates AuthNetworkError as-is', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      authManager.refresh = vi.fn().mockRejectedValue(new AuthNetworkError(new Error('offline')));
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } }
      );

      await expect(client.request({ method: 'GET', path: '/api/products/prod-1' }))
        .rejects.toBeInstanceOf(AuthNetworkError);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent 401s — apiClient delegates to authManager's own single-flight
  // ---------------------------------------------------------------------------

  describe('concurrent 401 requests', () => {
    it('each concurrent request that observes a 401 calls authManager.refresh() (single-flight collapsing is authManager\'s own responsibility, proven in authManager.test.js)', async () => {
      const authManager = makeMockAuthManager('stale-access-token');
      let refreshCallCount = 0;
      const resolvers = [];
      authManager.refresh = vi.fn(() => {
        refreshCallCount += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      });
      const client = createApiClient({ authManager, baseUrl: BASE_URL });

      mockFetchSequence(
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } },
        { status: 200, body: { id: 'a' } },
        { status: 200, body: { id: 'b' } },
        { status: 200, body: { id: 'c' } }
      );

      const p1 = client.request({ method: 'GET', path: '/api/a' });
      const p2 = client.request({ method: 'GET', path: '/api/b' });
      const p3 = client.request({ method: 'GET', path: '/api/c' });

      // Let all three first attempts settle to 401 (each triggering its
      // own refresh() call, since this mock authManager is deliberately
      // NOT single-flight) before resolving any of them.
      await vi.waitFor(() => expect(resolvers.length).toBe(3));

      authManager._setAccessToken('refreshed-access-token');
      resolvers.forEach((resolve) => resolve('refreshed-access-token'));

      await Promise.all([p1, p2, p3]);

      // This mock authManager's refresh() is deliberately NOT
      // single-flight itself -- so this test demonstrates only that
      // apiClient calls refresh() once per 401 it observes (three
      // concurrent requests -> three calls here). The actual
      // single-flight COLLAPSING guarantee is authManager's own
      // internal responsibility and is proven independently against the
      // real authManager in authManager.test.js -- not re-proven here
      // against a mock that doesn't implement it.
      expect(refreshCallCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope boundary
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not expose a syncQueue-processing method', () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      expect(client.processQueue).toBeUndefined();
      expect(client.drainQueue).toBeUndefined();
    });

    it('does not expose a login/logout method of its own', () => {
      const authManager = makeMockAuthManager('access-1');
      const client = createApiClient({ authManager, baseUrl: BASE_URL });
      expect(client.login).toBeUndefined();
      expect(client.logout).toBeUndefined();
    });
  });
});
