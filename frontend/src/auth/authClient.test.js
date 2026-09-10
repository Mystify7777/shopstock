import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuthClient, AuthApiError, AuthNetworkError } from './authClient.js';

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

function mockFetchOnce(status, body) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchNetworkFailure() {
  global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
}

function mockFetchInvalidJson() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError('Unexpected token')),
  });
}

describe('authClient', () => {
  let client;
  const BASE_URL = 'https://api.example.com';

  beforeEach(() => {
    client = createAuthClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // ---------------------------------------------------------------------------
  // createAuthClient — input validation
  // ---------------------------------------------------------------------------

  describe('createAuthClient', () => {
    it('throws for a non-string baseUrl', () => {
      expect(() => createAuthClient(undefined)).toThrow(TypeError);
      expect(() => createAuthClient(null)).toThrow(TypeError);
      expect(() => createAuthClient(123)).toThrow(TypeError);
    });

    it('accepts an empty string baseUrl (same-origin)', () => {
      expect(() => createAuthClient('')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------------

  describe('login', () => {
    it('POSTs to /api/auth/login with the exact request shape', async () => {
      mockFetchOnce(200, { accessToken: 'access-1', refreshToken: 'refresh-1' });

      await client.login('shopowner', 'hunter2');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ username: 'shopowner', password: 'hunter2' }),
        })
      );
    });

    it('does not attach an Authorization header', async () => {
      mockFetchOnce(200, { accessToken: 'access-1', refreshToken: 'refresh-1' });
      await client.login('shopowner', 'hunter2');
      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBeUndefined();
    });

    it('returns both tokens exactly as the server sent them', async () => {
      mockFetchOnce(200, { accessToken: 'access-1', refreshToken: 'refresh-1' });
      const result = await client.login('shopowner', 'hunter2');
      expect(result).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    });

    it('throws AuthApiError with the backend code/message on a validation failure', async () => {
      mockFetchOnce(400, { error: { code: 'VALIDATION_ERROR', message: 'Username and password are required.' } });
      await expect(client.login('', '')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'VALIDATION_ERROR',
        message: 'Username and password are required.',
        status: 400,
      });
    });

    it('throws AuthApiError with the backend code on invalid credentials (401)', async () => {
      mockFetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password.' } });
      await expect(client.login('shopowner', 'wrong')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });

    it('throws AuthNetworkError, not AuthApiError, on a transport failure', async () => {
      mockFetchNetworkFailure();
      await expect(client.login('shopowner', 'hunter2')).rejects.toBeInstanceOf(AuthNetworkError);
    });

    it('AuthNetworkError is thrown, not AuthApiError, for an invalid JSON response', async () => {
      mockFetchInvalidJson();
      await expect(client.login('shopowner', 'hunter2')).rejects.toBeInstanceOf(AuthNetworkError);
    });
  });

  // ---------------------------------------------------------------------------
  // refresh
  // ---------------------------------------------------------------------------

  describe('refresh', () => {
    it('POSTs to /api/auth/refresh with the exact request shape', async () => {
      mockFetchOnce(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      await client.refresh('refresh-1');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/auth/refresh',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refreshToken: 'refresh-1' }),
        })
      );
    });

    it('returns both the new access and new refresh token', async () => {
      mockFetchOnce(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      const result = await client.refresh('refresh-1');
      expect(result).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    });

    it('the returned refreshToken is treated as a distinct value from the one sent (rotation)', async () => {
      mockFetchOnce(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      const result = await client.refresh('refresh-1');
      expect(result.refreshToken).not.toBe('refresh-1');
    });

    it('throws AuthApiError with UNAUTHORIZED on a revoked/invalid refresh token', async () => {
      mockFetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token.' } });
      await expect(client.refresh('stale-token')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });

    it('throws AuthNetworkError on a transport failure', async () => {
      mockFetchNetworkFailure();
      await expect(client.refresh('refresh-1')).rejects.toBeInstanceOf(AuthNetworkError);
    });

    it('does not attach an Authorization header', async () => {
      mockFetchOnce(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      await client.refresh('refresh-1');
      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // logout
  // ---------------------------------------------------------------------------

  describe('logout', () => {
    it('POSTs to /api/auth/logout with the exact request shape', async () => {
      mockFetchOnce(200, { success: true });
      await client.logout('refresh-1');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/auth/logout',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refreshToken: 'refresh-1' }),
        })
      );
    });

    it('does not attach an Authorization header (matches the unauthenticated backend route)', async () => {
      mockFetchOnce(200, { success: true });
      await client.logout('refresh-1');
      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBeUndefined();
    });

    it('resolves without a return value on success', async () => {
      mockFetchOnce(200, { success: true });
      await expect(client.logout('refresh-1')).resolves.toBeUndefined();
    });

    it('throws AuthNetworkError on a transport failure', async () => {
      mockFetchNetworkFailure();
      await expect(client.logout('refresh-1')).rejects.toBeInstanceOf(AuthNetworkError);
    });
  });

  // ---------------------------------------------------------------------------
  // changePassword
  // ---------------------------------------------------------------------------

  describe('changePassword', () => {
    it('sends a PATCH to /api/auth/password with the exact request shape', async () => {
      mockFetchOnce(200, { success: true });
      await client.changePassword('access-1', 'oldpass', 'newpass');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/auth/password',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ currentPassword: 'oldpass', newPassword: 'newpass' }),
        })
      );
    });

    it('attaches the access token as a Bearer Authorization header', async () => {
      mockFetchOnce(200, { success: true });
      await client.changePassword('access-1', 'oldpass', 'newpass');
      const [, requestInit] = global.fetch.mock.calls[0];
      expect(requestInit.headers.Authorization).toBe('Bearer access-1');
    });

    it('resolves without a return value on success', async () => {
      mockFetchOnce(200, { success: true });
      await expect(client.changePassword('access-1', 'oldpass', 'newpass')).resolves.toBeUndefined();
    });

    it('throws AuthApiError with UNAUTHORIZED when the access token is rejected', async () => {
      mockFetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' } });
      await expect(client.changePassword('bad-token', 'oldpass', 'newpass')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'UNAUTHORIZED',
      });
    });

    it('throws AuthApiError with VALIDATION_ERROR when the current password is wrong', async () => {
      mockFetchOnce(400, { error: { code: 'VALIDATION_ERROR', message: 'Current password is incorrect.' } });
      await expect(client.changePassword('access-1', 'wrongpass', 'newpass')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'VALIDATION_ERROR',
      });
    });

    it('throws AuthNetworkError on a transport failure', async () => {
      mockFetchNetworkFailure();
      await expect(client.changePassword('access-1', 'oldpass', 'newpass')).rejects.toBeInstanceOf(AuthNetworkError);
    });
  });

  // ---------------------------------------------------------------------------
  // Error envelope edge cases
  // ---------------------------------------------------------------------------

  describe('error envelope edge cases', () => {
    it('falls back to a generic code/message when the error envelope is malformed', async () => {
      mockFetchOnce(500, {});
      await expect(client.login('a', 'b')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'UNKNOWN_ERROR',
        status: 500,
      });
    });

    it('falls back gracefully when the response body is entirely missing the error key', async () => {
      mockFetchOnce(500, { message: 'not the expected shape' });
      await expect(client.login('a', 'b')).rejects.toMatchObject({
        name: 'AuthApiError',
        code: 'UNKNOWN_ERROR',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Statelessness — no token retained between calls
  // ---------------------------------------------------------------------------

  describe('statelessness', () => {
    it('does not retain or reuse tokens between separate calls', async () => {
      mockFetchOnce(200, { accessToken: 'access-1', refreshToken: 'refresh-1' });
      await client.login('shopowner', 'hunter2');

      mockFetchOnce(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      await client.refresh('refresh-1');

      // mockFetchOnce() installs a fresh fetch mock per call, so this
      // second mock's own call history reflects only the refresh() call
      // -- confirming it sent exactly 'refresh-1' (the value the caller
      // passed), not anything cached from the prior login() call.
      const [, requestInit] = global.fetch.mock.calls[0];
      expect(JSON.parse(requestInit.body)).toEqual({ refreshToken: 'refresh-1' });
    });

    it('exposes no method for reading a "current" token — every call requires explicit input', () => {
      expect(client.getAccessToken).toBeUndefined();
      expect(client.getRefreshToken).toBeUndefined();
    });
  });
});
