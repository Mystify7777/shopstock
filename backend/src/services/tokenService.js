// Token generation and hashing utilities. Deliberately pure/side-effect
// free (no Mongo, no Express) so the mechanics are testable in isolation
// from persistence and routing -- only the User model touches the
// database.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Generate a new opaque refresh token: a 256-bit cryptographically random
 * value, hex-encoded. Never derived from anything predictable (not a
 * JWT, not a hash of user data) -- its entire security value comes from
 * being unguessable.
 *
 * @returns {string}
 */
export function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a raw refresh token with SHA-256 for storage/lookup. See
 * models/User.js's header comment for why SHA-256 rather than bcrypt is
 * the correct choice here. The raw token itself must never be persisted
 * or logged anywhere -- only this hash.
 *
 * @param {string} rawToken
 * @returns {string} hex-encoded digest
 */
export function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Compute the expiresAt Date for a newly-issued refresh token, given the
 * configured validity window in days.
 *
 * @param {number} refreshTokenExpiresInDays
 * @param {Date} [now] Injectable for deterministic tests.
 * @returns {Date}
 */
export function computeRefreshTokenExpiry(refreshTokenExpiresInDays, now = new Date()) {
  return new Date(now.getTime() + refreshTokenExpiresInDays * 24 * 60 * 60 * 1000);
}

/**
 * Sign a short-lived access token JWT. Payload is deliberately minimal:
 * just the subject (user id). No username, no role claims -- there is
 * exactly one user and no roles exist in this application.
 *
 * @param {{ userId: string, secret: string, expiresIn: string }} params
 * @returns {string}
 */
export function signAccessToken({ userId, secret, expiresIn }) {
  return jwt.sign({ sub: userId }, secret, { expiresIn });
}

/**
 * Verify an access token JWT. Throws (does not catch/wrap) on an
 * invalid/expired/malformed token -- callers (the auth middleware)
 * decide how to translate that into an AppError.
 *
 * @param {{ token: string, secret: string }} params
 * @returns {{ sub: string, iat: number, exp: number }}
 */
export function verifyAccessToken({ token, secret }) {
  return jwt.verify(token, secret);
}
