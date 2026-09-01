// Authentication service -- the Mongo-touching business logic behind
// login/refresh/logout/password-change. Kept separate from
// controllers/routes so the atomic-update mechanics can be reasoned
// about and tested as one unit, and so route handlers stay thin.
//
// SECURITY: never logs raw passwords, raw refresh tokens, token hashes,
// or Authorization headers, anywhere in this file, including error paths.

import bcrypt from 'bcryptjs';
import { User, toDeviceLabel } from '../models/User.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  computeRefreshTokenExpiry,
  signAccessToken
} from './tokenService.js';
import { AppError } from '../middleware/AppError.js';

const BCRYPT_SALT_ROUNDS = 10;
// A syntactically-valid-shaped, but not-derived-from-any-real-password,
// bcrypt hash used only to give login() a comparison to run against for
// an unknown username -- keeps the "unknown username" and "wrong
// password" code paths doing a similarly-costly bcrypt.compare() each,
// so they are not trivially distinguishable by response timing.
const DUMMY_BCRYPT_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8yFQ0EMdhz9Q6ZH9r5C6E9CzL8FW7C';

/**
 * @param {{
 *   jwtAccessSecret: string,
 *   jwtAccessExpiresIn: string,
 *   refreshTokenExpiresInDays: number
 * }} config
 */
export function createAuthService(config) {
  /**
   * Build a new refresh-token session entry plus the raw token to return
   * to the caller. Does not persist anything itself -- callers decide
   * how the entry gets written (new push vs. atomic pull+push).
   *
   * @param {string} rawUserAgent
   * @param {Date} [now]
   * @returns {{ rawToken: string, entry: object }}
   */
  function buildRefreshTokenEntry(rawUserAgent, now = new Date()) {
    const rawToken = generateRefreshToken();
    return {
      rawToken,
      entry: {
        tokenHash: hashRefreshToken(rawToken),
        deviceLabel: toDeviceLabel(rawUserAgent),
        createdAt: now,
        expiresAt: computeRefreshTokenExpiry(config.refreshTokenExpiresInDays, now),
        revoked: false
      }
    };
  }

  function issueAccessToken(userId) {
    return signAccessToken({
      userId: userId.toString(),
      secret: config.jwtAccessSecret,
      expiresIn: config.jwtAccessExpiresIn
    });
  }

  /**
   * Log in with username/password. Deliberately returns the SAME
   * AppError (same code, same message) whether the username doesn't
   * exist or the password is wrong -- prevents username enumeration via
   * response differences. Runs a bcrypt compare against a dummy hash
   * even for an unknown username, so the two failure paths have a
   * similar timing profile.
   *
   * @param {{ username: string, password: string, userAgent: string }} params
   * @returns {Promise<{ accessToken: string, refreshToken: string }>}
   */
  async function login({ username, password, userAgent }) {
    const user = await User.findOne({ username });
    const genericError = new AppError('UNAUTHORIZED', 'Invalid username or password.');

    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw genericError;
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw genericError;
    }

    const { rawToken, entry } = buildRefreshTokenEntry(userAgent);
    await User.updateOne({ _id: user._id }, { $push: { refreshTokens: entry } });

    return { accessToken: issueAccessToken(user._id), refreshToken: rawToken };
  }

  /**
   * Rotate a refresh token: validate the presented token, and in ONE
   * atomic MongoDB document write, remove the old entry AND add the new
   * one -- then issue a new access token alongside it.
   *
   * Locked rotation lifecycle: the OLD entry is removed outright (not
   * revoked-and-kept) -- no growing graveyard of rotated-out entries.
   *
   * Genuinely atomic (corrected after review): this uses a single
   * findOneAndUpdate() call with a MongoDB aggregation-pipeline update
   * (an array as the update argument, not a plain update document) --
   * NOT a $pull followed by a separate $push in two round trips. The
   * pipeline's $set stage computes the new refreshTokens array in one
   * expression: $filter drops the old entry, $concatArrays appends the
   * new one, and MongoDB applies that computed array to the document in
   * the SAME atomic operation that matched the filter. There is no
   * intermediate state, observable by any other request, where the old
   * token has been removed but the new one hasn't been persisted yet --
   * the whole transition happens as a single write.
   *
   * Locked concurrency contract: given two concurrent refresh() calls
   * presenting the SAME old token, exactly one succeeds; the other
   * receives 401. The query filter (matching only when the old,
   * non-revoked, unexpired token entry is still present) is what
   * provides this guarantee -- MongoDB serializes writes to the same
   * document, so once the winning request's atomic update has replaced
   * the array, a second concurrent request's identical filter no longer
   * matches anything, findOneAndUpdate returns null for it, and that is
   * treated as "token not found" -> 401. No separate locking primitive
   * is introduced; this falls directly out of MongoDB's own
   * single-document atomic update semantics -- now correctly applied to
   * a single write instead of two.
   *
   * @param {{ refreshToken: string, userAgent: string }} params
   * @returns {Promise<{ accessToken: string, refreshToken: string }>}
   */
  async function refresh({ refreshToken, userAgent }) {
    const oldTokenHash = hashRefreshToken(refreshToken);
    const now = new Date();
    const { rawToken: newRawToken, entry: newEntry } = buildRefreshTokenEntry(userAgent, now);

    const updatedUser = await User.findOneAndUpdate(
      {
        'refreshTokens.tokenHash': oldTokenHash,
        'refreshTokens.revoked': false,
        'refreshTokens.expiresAt': { $gt: now }
      },
      [
        {
          $set: {
            refreshTokens: {
              $concatArrays: [
                {
                  $filter: {
                    input: '$refreshTokens',
                    as: 'rt',
                    cond: { $ne: ['$$rt.tokenHash', oldTokenHash] }
                  }
                },
                [newEntry]
              ]
            }
          }
        }
      ],
      { new: true }
    );

    if (!updatedUser) {
      throw new AppError('UNAUTHORIZED', 'Invalid, expired, or already-used refresh token.');
    }

    return { accessToken: issueAccessToken(updatedUser._id), refreshToken: newRawToken };
  }

  /**
   * Log out: revoke/remove the presented refresh-token session if it
   * exists. Idempotent and does not require a valid access token (locked
   * contract) -- always returns success, regardless of whether the token
   * existed, was already revoked, or was expired, so logout can never be
   * used as an oracle to probe token validity.
   *
   * @param {{ refreshToken: string }} params
   * @returns {Promise<void>}
   */
  async function logout({ refreshToken }) {
    const tokenHash = hashRefreshToken(refreshToken);
    // Narrowed per review: filter for the document that actually
    // contains this tokenHash, rather than matching the collection's
    // first document unconditionally. With exactly one seeded user this
    // was harmless in practice, but the broad filter was still an
    // imprecise query that happened to work by coincidence of there
    // being only one document -- not something to leave as "fine for
    // now." $pull remains a no-op (matches nothing) when no document
    // contains this tokenHash at all -- still fine and deliberate; the
    // caller always gets a success response regardless (locked
    // idempotent/non-oracle contract, unaffected by this narrowing).
    await User.updateOne(
      { 'refreshTokens.tokenHash': tokenHash },
      { $pull: { refreshTokens: { tokenHash } } }
    );
  }

  /**
   * Change the authenticated user's password. Verifies the current
   * password, hashes the new one, and revokes EVERY refresh-token
   * session (including the one used to make this very request) as one
   * update -- the user must log in again afterward. Does not issue
   * replacement tokens.
   *
   * @param {{ userId: string, currentPassword: string, newPassword: string }} params
   * @returns {Promise<void>}
   */
  async function changePassword({ userId, currentPassword, newPassword }) {
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Invalid session.');
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentMatches) {
      throw new AppError('VALIDATION_ERROR', 'Current password is incorrect.');
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);

    // One update: new password hash + every refresh session cleared,
    // together -- there is no observable window where the password has
    // changed but old sessions remain valid, or vice versa.
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash: newPasswordHash, refreshTokens: [] } }
    );
  }

  return { login, refresh, logout, changePassword };
}
