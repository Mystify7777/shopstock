import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRefreshToken,
  hashRefreshToken,
  computeRefreshTokenExpiry,
  signAccessToken,
  verifyAccessToken
} from '../../src/services/tokenService.js';

describe('generateRefreshToken', () => {
  test('returns a 64-character hex string (256 bits, hex-encoded)', () => {
    const token = generateRefreshToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  test('returns a different value on every call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(a, b);
  });
});

describe('hashRefreshToken', () => {
  test('is deterministic for the same input', () => {
    const token = generateRefreshToken();
    assert.equal(hashRefreshToken(token), hashRefreshToken(token));
  });

  test('produces a different hash for a different token', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(hashRefreshToken(a), hashRefreshToken(b));
  });

  test('the hash never equals the raw token itself', () => {
    const token = generateRefreshToken();
    assert.notEqual(hashRefreshToken(token), token);
  });

  test('produces a 64-character hex digest (SHA-256)', () => {
    const hash = hashRefreshToken(generateRefreshToken());
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

describe('computeRefreshTokenExpiry', () => {
  test('adds the configured number of days to the given "now"', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = computeRefreshTokenExpiry(90, now);
    assert.equal(expiry.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  test('defaults "now" to the current time when omitted', () => {
    const before = Date.now();
    const expiry = computeRefreshTokenExpiry(1);
    const after = Date.now();
    const expiryMs = expiry.getTime();
    // Expiry should be ~1 day (86400000ms) after some point between
    // `before` and `after`.
    assert.ok(expiryMs >= before + 86_400_000);
    assert.ok(expiryMs <= after + 86_400_000);
  });
});

describe('signAccessToken / verifyAccessToken', () => {
  const secret = 'test-secret-do-not-use-in-real-life';

  test('a signed token can be verified and contains the correct subject', () => {
    const token = signAccessToken({ userId: 'user-123', secret, expiresIn: '15m' });
    const decoded = verifyAccessToken({ token, secret });
    assert.equal(decoded.sub, 'user-123');
  });

  test('the JWT payload contains only sub plus standard JWT claims -- no username, no role', () => {
    const token = signAccessToken({ userId: 'user-123', secret, expiresIn: '15m' });
    const decoded = verifyAccessToken({ token, secret });
    const keys = Object.keys(decoded).sort();
    // sub, iat, exp are the only expected claims -- jsonwebtoken adds
    // iat/exp automatically for an expiresIn-signed token.
    assert.deepEqual(keys, ['exp', 'iat', 'sub']);
  });

  test('verifying with the wrong secret throws', () => {
    const token = signAccessToken({ userId: 'user-123', secret, expiresIn: '15m' });
    assert.throws(() => verifyAccessToken({ token, secret: 'wrong-secret' }));
  });

  test('verifying an expired token throws', async () => {
    const token = signAccessToken({ userId: 'user-123', secret, expiresIn: '1ms' });
    // Give the 1ms expiry time to actually pass.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => verifyAccessToken({ token, secret }), /expired/i);
  });

  test('verifying a malformed token throws', () => {
    assert.throws(() => verifyAccessToken({ token: 'not-a-real-jwt', secret }));
  });
});
