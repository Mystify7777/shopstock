// API client — generic authenticated HTTP requests.
//
// This file owns:
//   - constructing and sending an arbitrary request ({ method, path,
//     body }) against the backend, attaching the current access token
//     from authManager when one exists
//   - parsing the backend's uniform error envelope ({ error: { code,
//     message } }) into a typed error, same shape/spirit as
//     authClient.js's AuthApiError -- but this is a GENERIC client, not
//     auth-specific, so it gets its own error types rather than reusing
//     authClient.js's (which are conceptually scoped to the four auth
//     endpoints)
//   - detecting HTTP 401 on a request and coordinating exactly one
//     refresh-then-retry, via authManager.refresh() -- the single-flight
//     guarantee itself lives entirely in authManager.js; this module
//     just calls it and reacts to the outcome
//
// This file does NOT own:
//   - the syncQueue, or any decision about WHEN to send a request or
//     which entries to send -- callers (a future sync processor) decide
//     what to send; this module only sends what it's given, one request
//     at a time
//   - browser connectivity listeners (navigator.onLine, online/offline
//     events) -- out of scope per the locked contract, later Phase 6
//   - domain entity mutation or business/domain validation
//   - authentication state itself, single-flight refresh coordination,
//     or credential persistence -- all of that is authManager.js; this
//     module is a thin consumer of it, not a second auth authority
//
// The request shape this module accepts -- { method, path, body } -- is
// deliberately identical to createSyncRequest()'s return shape
// (frontend/src/data/sync/syncRequest.js), so a future sync processor
// can call apiClient.request(createSyncRequest(entry)) directly without
// any adapter layer in between. That processor does not exist yet
// (later Phase 6 pass) -- this module is built to be ready for it, not
// to include it.

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * The backend responded with an error envelope and a non-2xx status,
 * AFTER any applicable refresh-and-retry has already been exhausted (a
 * 401 that gets resolved by a successful refresh+retry never surfaces
 * as an error to the caller at all -- only a persisting or non-401
 * failure does).
 */
export class ApiRequestError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The request never received a response at all -- network/transport
 * failure. Deliberately distinct from ApiRequestError for the same
 * reason as authClient.js's AuthNetworkError: callers must be able to
 * tell "offline" apart from "the server rejected this."
 */
export class ApiNetworkError extends Error {
  constructor(cause) {
    super('Network error while contacting the server.');
    this.name = 'ApiNetworkError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal request helper
// ---------------------------------------------------------------------------

/**
 * Send one HTTP request exactly as given, with no refresh/retry logic --
 * that coordination lives in request() below, one level up. Attaches an
 * Authorization header only if accessToken is truthy.
 *
 * @param {string} baseUrl
 * @param {{ method: string, path: string, body?: object }} req
 * @param {string|null} accessToken
 * @returns {Promise<{ status: number, ok: boolean, data: object }>}
 * @throws {ApiNetworkError} on transport failure or an unparseable body.
 */
async function sendOnce(baseUrl, { method, path, body }, accessToken) {
  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiNetworkError(cause);
  }

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw new ApiNetworkError(cause);
  }

  return { status: response.status, ok: response.ok, data };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   authManager: ReturnType<import('./authManager.js').createAuthManager>,
 *   baseUrl: string,
 * }} deps
 * @returns {{
 *   request: (req: { method: string, path: string, body?: object }) => Promise<object>,
 * }}
 */
export function createApiClient({ authManager, baseUrl }) {
  if (!authManager) {
    throw new TypeError('createApiClient requires { authManager, baseUrl }.');
  }
  if (typeof baseUrl !== 'string') {
    throw new TypeError('createApiClient(baseUrl) requires a string baseUrl (use \'\' for same-origin).');
  }

  /**
   * Send an authenticated request, with bounded 401 recovery.
   *
   * Policy (locked contract, Section 6):
   *   - No access token currently held -> send without an Authorization
   *     header at all (not an empty/invalid one).
   *   - Response is 401 on the FIRST attempt -> call authManager.refresh()
   *     exactly once, then retry the original request exactly once with
   *     whatever access token results.
   *   - A second 401, on the retried request, does NOT trigger another
   *     refresh -- it surfaces as ApiRequestError immediately. This is
   *     the bound that prevents an unbounded refresh/retry loop.
   *   - If authManager.refresh() itself fails (expired/revoked refresh
   *     token, or a network failure), that failure propagates to the
   *     caller as-is (AuthApiError or AuthNetworkError from
   *     authManager/authClient) rather than being masked as a generic
   *     ApiRequestError -- the caller needs to know WHY the request
   *     couldn't be completed, and authManager has already updated its
   *     own state accordingly (session cleared on AuthApiError, left
   *     alone on AuthNetworkError).
   *
   * @param {{ method: string, path: string, body?: object }} req
   * @returns {Promise<object>} The parsed JSON response body on success.
   * @throws {ApiRequestError} on a non-2xx, non-recoverable response.
   * @throws {ApiNetworkError} on a transport failure.
   * @throws {import('./authClient.js').AuthApiError |
   *          import('./authClient.js').AuthNetworkError} if the 401
   *   recovery's own refresh attempt fails.
   */
  async function request(req) {
    const firstAttempt = await sendOnce(baseUrl, req, authManager.getAccessToken());

    if (firstAttempt.ok) {
      return firstAttempt.data;
    }

    if (firstAttempt.status !== 401) {
      throw toApiRequestError(firstAttempt);
    }

    // First attempt was 401 -- attempt exactly one refresh, then exactly
    // one retry. authManager.refresh() is single-flight internally, so
    // multiple concurrent request() calls hitting 401 at the same time
    // will all await the SAME refresh rather than each independently
    // triggering one.
    await authManager.refresh();

    const retryAttempt = await sendOnce(baseUrl, req, authManager.getAccessToken());

    if (retryAttempt.ok) {
      return retryAttempt.data;
    }

    // Whether the retry failed with another 401 or something else, this
    // is where the bound stops: no second refresh is attempted under
    // any circumstance.
    throw toApiRequestError(retryAttempt);
  }

  return { request };
}

/**
 * @param {{ status: number, data: object }} attempt
 */
function toApiRequestError({ status, data }) {
  const code = data?.error?.code ?? 'UNKNOWN_ERROR';
  const message = data?.error?.message ?? 'The request failed.';
  return new ApiRequestError(code, message, status);
}
