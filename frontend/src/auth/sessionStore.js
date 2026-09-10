// Session store — Dexie `session` table persistence.
//
// The `session` table (frontend/src/data/db/schema.js: `session: 'key'`) is
// a single-row key-value store. Per the locked Phase 6B2 contract, it holds
// exactly one thing: the refresh token needed to restore an authenticated
// session on startup. The access token is NEVER persisted here or anywhere
// else durable — it lives in memory only, owned by authManager.js.
//
// This file owns:
//   - reading the persisted refresh token
//   - persisting a refresh token (login, successful refresh rotation)
//   - clearing the persisted refresh token (logout, failed refresh)
//
// This file does NOT own:
//   - any HTTP call (that's authClient.js)
//   - authentication state / in-memory access token (that's authManager.js)
//   - single-flight refresh coordination (that's authManager.js)
//   - deciding WHEN to persist/clear — callers (authManager.js) decide;
//     this module only performs the requested read/write/clear

const SESSION_KEY = 'current';

/**
 * @param {import('dexie').Dexie} db A database instance from createDatabase().
 * @returns {{
 *   getRefreshToken: () => Promise<string|null>,
 *   setRefreshToken: (refreshToken: string) => Promise<void>,
 *   clearRefreshToken: () => Promise<void>,
 * }}
 */
export function createSessionStore(db) {
  /**
   * Read the persisted refresh token.
   *
   * @returns {Promise<string|null>} The refresh token, or null if no
   *   session record exists, or the record exists but has no refreshToken
   *   (both are treated as "no persisted session" — a missing record is a
   *   normal unauthenticated state, per the locked contract).
   */
  async function getRefreshToken() {
    const record = await db.session.get(SESSION_KEY);
    if (!record || typeof record.value !== 'object' || record.value === null) {
      return null;
    }
    return record.value.refreshToken ?? null;
  }

  /**
   * Persist a refresh token, replacing any previously stored value.
   *
   * A successful call fully overwrites the prior session record — this is
   * a single-row table, so there is no notion of merging with existing
   * fields (the persisted shape is intentionally minimal, per the locked
   * contract: `{ refreshToken }`, nothing else).
   *
   * @param {string} refreshToken
   */
  async function setRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new TypeError(
        'setRefreshToken() requires a non-empty string refreshToken.'
      );
    }
    await db.session.put({ key: SESSION_KEY, value: { refreshToken } });
  }

  /**
   * Clear the persisted refresh token entirely (delete the row, not just
   * null out the field) — used on logout and on failed session
   * restoration, per the locked contract ("failed refresh clears the
   * persisted refresh credential").
   */
  async function clearRefreshToken() {
    await db.session.delete(SESSION_KEY);
  }

  return { getRefreshToken, setRefreshToken, clearRefreshToken };
}
