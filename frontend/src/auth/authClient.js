// Auth client — stateless HTTP calls to the backend auth endpoints.
//
// This file owns:
//   - constructing and sending the four auth requests (login, refresh,
//     logout, changePassword) against the real Phase 5 backend contract
//   - parsing the backend's uniform error envelope ({ error: { code,
//     message } }) into a typed error the caller can inspect
//   - distinguishing a network/transport failure from a backend error
//     response (both surface as thrown errors, but as different classes
//     — callers must be able to tell "the server said no" apart from
//     "the request never reached the server")
//
// This file does NOT own:
//   - any token storage, in memory or persisted (no state at all — every
//     exported function is a pure request/response round-trip; the
//     access/refresh tokens returned by login/refresh are handed straight
//     back to the caller and retained nowhere in this module)
//   - authentication state (authenticated/unauthenticated) — that's
//     authManager.js
//   - single-flight coordination, retry, or refresh-on-401 policy —
//     those are authManager.js/apiClient.js concerns, layered on top of
//     these plain requests
//   - deciding WHEN to call refresh/logout — callers decide; this module
//     only performs the call it's asked to make
//
// See docs/ARCHITECTURE.md, "Authentication" section, and Phase 6B1's
// contract investigation (docs/PROGRESS.md) for the verified backend
// request/response shapes this file implements against.

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * The backend responded with an error envelope
 * ({ error: { code, message} }) and a non-2xx status. `code` is one of
 * the backend's locked error-code vocabulary (see backend/src/middleware
 * /AppError.js) — callers that need to branch on a specific failure
 * (e.g. UNAUTHORIZED vs VALIDATION_ERROR) should inspect `.code`, not
 * parse `.message`, which is only for display.
 */
export class AuthApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The request never received a response from the backend at all — a
 * network failure, DNS failure, CORS failure, or similar transport-level
 * problem. Deliberately a DIFFERENT class from AuthApiError: per the
 * locked 6B2 contract, "a transport failure must not be converted into
 * 'session expired.'" Callers (authManager.js) must be able to tell
 * these apart to avoid treating "offline" as "logged out."
 */
export class AuthNetworkError extends Error {
  constructor(cause) {
    super('Network error while contacting the authentication server.');
    this.name = 'AuthNetworkError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal request helper
// ---------------------------------------------------------------------------

/**
 * Perform one auth HTTP request and normalize the outcome.
 *
 * @param {string} baseUrl
 * @param {string} path e.g. '/api/auth/login'
 * @param {object} body
 * @param {{ accessToken?: string }} [options] When accessToken is
 *   provided, attaches it as a Bearer token — only changePassword needs
 *   this; the other three auth endpoints are deliberately unauthenticated.
 * @returns {Promise<object>} The parsed JSON response body on success.
 * @throws {AuthApiError} on a non-2xx response with a parseable error
 *   envelope.
 * @throws {AuthNetworkError} if the request never completes (network
 *   failure) or the response body isn't valid JSON.
 */
async function postJson(baseUrl, path, body, options = {}) {
  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // fetch() itself threw -- the request never got a response at all.
    throw new AuthNetworkError(cause);
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch (cause) {
    // Got a response, but the body isn't valid JSON -- treat as a
    // transport-level anomaly rather than fabricating a backend error
    // code that was never actually returned.
    throw new AuthNetworkError(cause);
  }

  if (!response.ok) {
    const code = parsed?.error?.code ?? 'UNKNOWN_ERROR';
    const message = parsed?.error?.message ?? 'The request failed.';
    throw new AuthApiError(code, message, response.status);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} baseUrl Backend origin, e.g. 'https://api.example.com'
 *   or '' for same-origin relative requests. Passed explicitly rather
 *   than read from import.meta.env inside this module, so the module
 *   stays trivially testable without Vite env mocking — the composition
 *   root is responsible for resolving the real configured value.
 * @returns {{
 *   login: (username: string, password: string) => Promise<{accessToken: string, refreshToken: string}>,
 *   refresh: (refreshToken: string) => Promise<{accessToken: string, refreshToken: string}>,
 *   logout: (refreshToken: string) => Promise<void>,
 *   changePassword: (accessToken: string, currentPassword: string, newPassword: string) => Promise<void>,
 * }}
 */
export function createAuthClient(baseUrl) {
  if (typeof baseUrl !== 'string') {
    throw new TypeError('createAuthClient(baseUrl) requires a string baseUrl (use \'\' for same-origin).');
  }

  /**
   * POST /api/auth/login
   * The frontend must treat both returned tokens as opaque credentials
   * from the server — never derived, decoded, or manufactured here.
   */
  async function login(username, password) {
    const result = await postJson(baseUrl, '/api/auth/login', { username, password });
    return { accessToken: result.accessToken, refreshToken: result.refreshToken };
  }

  /**
   * POST /api/auth/refresh
   * Rotating: the supplied refreshToken is consumed server-side; the
   * returned refreshToken is a DIFFERENT token that replaces it. This
   * function does not persist anything itself -- the caller
   * (authManager.js) is responsible for treating the two returned
   * values as one atomic credential-replacement unit.
   */
  async function refresh(refreshToken) {
    const result = await postJson(baseUrl, '/api/auth/refresh', { refreshToken });
    return { accessToken: result.accessToken, refreshToken: result.refreshToken };
  }

  /**
   * POST /api/auth/logout
   * Deliberately does not require or accept an access token (matches
   * the backend's unauthenticated route). Idempotent and non-oracle on
   * the backend side -- always resolves on a 2xx response regardless of
   * whether the presented refreshToken was valid; this function must
   * not be used by callers to infer refresh-token validity.
   */
  async function logout(refreshToken) {
    await postJson(baseUrl, '/api/auth/logout', { refreshToken });
  }

  /**
   * PATCH /api/auth/password
   * The only one of the four endpoints that requires an access token —
   * matches the backend's requireAuth-protected route.
   */
  async function changePassword(accessToken, currentPassword, newPassword) {
    await postJson(
      baseUrl,
      '/api/auth/password',
      { currentPassword, newPassword },
      { method: 'PATCH', accessToken }
    );
  }

  return { login, refresh, logout, changePassword };
}
