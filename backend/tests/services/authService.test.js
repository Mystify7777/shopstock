// NOT EXECUTED IN THIS SANDBOX -- see backend/README.md and
// docs/PROGRESS.md's Phase 5B entry. This file requires a real MongoDB
// connection via tests/helpers/testDb.js's MongoMemoryReplSet, which
// cannot download its binary in this development sandbox (network
// allowlist does not include fastdl.mongodb.org). Written to the locked
// Phase 5B contract and reasoned through carefully (see authService.js's
// own comments on the refresh() concurrency argument), but must be run
// for real -- locally, or in an environment with the necessary network
// access -- before this slice's completion gate can be honestly claimed.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { User } from '../../src/models/User.js';
import { createAuthService } from '../../src/services/authService.js';
import { verifyAccessToken, hashRefreshToken } from '../../src/services/tokenService.js';

const CONFIG = {
  jwtAccessSecret: 'test-secret',
  jwtAccessExpiresIn: '15m',
  refreshTokenExpiresInDays: 90
};

async function createTestUser({ username = 'shopowner', password = 'correct-horse-battery-staple' } = {}) {
  const passwordHash = await bcrypt.hash(password, 10);
  return User.create({ username, passwordHash, refreshTokens: [] });
}

describe('authService', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  const authService = createAuthService(CONFIG);

  describe('login', () => {
    test('succeeds with the correct username and password, returning both tokens', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const result = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'test-agent'
      });
      assert.equal(typeof result.accessToken, 'string');
      assert.equal(typeof result.refreshToken, 'string');
    });

    test('the returned access token verifies and contains the correct user id', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const result = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'test-agent'
      });
      const decoded = verifyAccessToken({ token: result.accessToken, secret: CONFIG.jwtAccessSecret });
      assert.equal(decoded.sub, user._id.toString());
    });

    test('persists a new refresh-token session on the user document', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const result = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'test-agent'
      });
      const reloaded = await User.findById(user._id);
      assert.equal(reloaded.refreshTokens.length, 1);
      assert.equal(reloaded.refreshTokens[0].tokenHash, hashRefreshToken(result.refreshToken));
    });

    test('the raw refresh token never appears anywhere in the persisted document', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const result = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'test-agent'
      });
      const reloaded = await User.findOne({ username: 'shopowner' }).lean();
      assert.doesNotMatch(JSON.stringify(reloaded), new RegExp(result.refreshToken));
    });

    test('fails with a nonexistent username', async () => {
      await assert.rejects(
        () => authService.login({ username: 'nobody', password: 'whatever', userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });

    test('fails with the wrong password', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      await assert.rejects(
        () => authService.login({ username: 'shopowner', password: 'wrong-password', userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });

    test('the error for a wrong password and a nonexistent username is identical (no username enumeration)', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });

      let wrongPasswordError;
      try {
        await authService.login({ username: 'shopowner', password: 'wrong-password', userAgent: 'x' });
      } catch (err) {
        wrongPasswordError = err;
      }

      let unknownUserError;
      try {
        await authService.login({ username: 'nobody', password: 'whatever', userAgent: 'x' });
      } catch (err) {
        unknownUserError = err;
      }

      assert.equal(wrongPasswordError.code, unknownUserError.code);
      assert.equal(wrongPasswordError.message, unknownUserError.message);
    });

    test('device label is derived from the provided userAgent and bounded/trimmed', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: '  Mozilla/5.0 Test Browser  '
      });
      const reloaded = await User.findOne({ username: 'shopowner' });
      assert.equal(reloaded.refreshTokens[0].deviceLabel, 'Mozilla/5.0 Test Browser');
    });
  });

  describe('refresh', () => {
    async function loginAndGetTokens() {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      return authService.login({ username: 'shopowner', password: 'correct-password', userAgent: 'x' });
    }

    test('a valid refresh token returns a new access token and a new refresh token', async () => {
      const { refreshToken } = await loginAndGetTokens();
      const result = await authService.refresh({ refreshToken, userAgent: 'x' });
      assert.equal(typeof result.accessToken, 'string');
      assert.equal(typeof result.refreshToken, 'string');
      assert.notEqual(result.refreshToken, refreshToken);
    });

    test('the OLD token entry is removed, not merely marked revoked -- no growing graveyard', async () => {
      const { refreshToken } = await loginAndGetTokens();
      await authService.refresh({ refreshToken, userAgent: 'x' });
      const user = await User.findOne({ username: 'shopowner' });
      // Exactly one entry (the NEW one) should exist -- the old one is
      // gone entirely, not present-and-revoked.
      assert.equal(user.refreshTokens.length, 1);
      assert.notEqual(user.refreshTokens[0].tokenHash, hashRefreshToken(refreshToken));
    });

    test('the old token cannot be used again after rotation', async () => {
      const { refreshToken } = await loginAndGetTokens();
      await authService.refresh({ refreshToken, userAgent: 'x' });
      await assert.rejects(
        () => authService.refresh({ refreshToken, userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });

    test('CRITICAL: two concurrent refresh attempts using the same token -- exactly one succeeds, the other gets 401, never both succeeding', async () => {
      const { refreshToken } = await loginAndGetTokens();

      const results = await Promise.allSettled([
        authService.refresh({ refreshToken, userAgent: 'device-a' }),
        authService.refresh({ refreshToken, userAgent: 'device-b' })
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'exactly one concurrent refresh must succeed');
      assert.equal(rejected.length, 1, 'exactly one concurrent refresh must fail');
      assert.equal(rejected[0].reason.code, 'UNAUTHORIZED');

      // And the user document ends up with exactly one refresh token
      // session -- not two, not zero.
      const user = await User.findOne({ username: 'shopowner' });
      assert.equal(user.refreshTokens.length, 1);
    });

    test('a revoked token is rejected', async () => {
      const { refreshToken } = await loginAndGetTokens();
      await authService.logout({ refreshToken });
      await assert.rejects(
        () => authService.refresh({ refreshToken, userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });

    test('an expired token is rejected', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const user = await User.findOne({ username: 'shopowner' });
      const expiredToken = 'a'.repeat(64);
      user.refreshTokens.push({
        tokenHash: hashRefreshToken(expiredToken),
        deviceLabel: 'x',
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1000), // already expired
        revoked: false
      });
      await user.save();

      await assert.rejects(
        () => authService.refresh({ refreshToken: expiredToken, userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });

    test('an unknown/garbage token is rejected', async () => {
      await assert.rejects(
        () => authService.refresh({ refreshToken: 'never-issued-token', userAgent: 'x' }),
        (err) => err.code === 'UNAUTHORIZED'
      );
    });
  });

  describe('logout', () => {
    test('a valid refresh token is removed and can no longer be used', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const { refreshToken } = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'x'
      });

      await authService.logout({ refreshToken });

      const user = await User.findOne({ username: 'shopowner' });
      assert.equal(user.refreshTokens.length, 0);
    });

    test('logging out twice with the same token does not throw (idempotent)', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const { refreshToken } = await authService.login({
        username: 'shopowner',
        password: 'correct-password',
        userAgent: 'x'
      });

      await authService.logout({ refreshToken });
      await assert.doesNotReject(() => authService.logout({ refreshToken }));
    });

    test('logging out with a never-issued token does not throw and does not reveal anything', async () => {
      await assert.doesNotReject(() => authService.logout({ refreshToken: 'never-issued-token' }));
    });

    test('logout only removes the presented session, leaving other device sessions intact', async () => {
      await createTestUser({ username: 'shopowner', password: 'correct-password' });
      const sessionA = await authService.login({ username: 'shopowner', password: 'correct-password', userAgent: 'device-a' });
      const sessionB = await authService.login({ username: 'shopowner', password: 'correct-password', userAgent: 'device-b' });

      await authService.logout({ refreshToken: sessionA.refreshToken });

      const user = await User.findOne({ username: 'shopowner' });
      assert.equal(user.refreshTokens.length, 1);
      assert.equal(user.refreshTokens[0].tokenHash, hashRefreshToken(sessionB.refreshToken));
    });
  });

  describe('changePassword', () => {
    test('succeeds with the correct current password and updates the hash', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'old-password' });
      await authService.changePassword({
        userId: user._id.toString(),
        currentPassword: 'old-password',
        newPassword: 'new-password'
      });

      const reloaded = await User.findById(user._id);
      const oldStillMatches = await bcrypt.compare('old-password', reloaded.passwordHash);
      const newMatches = await bcrypt.compare('new-password', reloaded.passwordHash);
      assert.equal(oldStillMatches, false);
      assert.equal(newMatches, true);
    });

    test('rejects an incorrect current password', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'old-password' });
      await assert.rejects(
        () => authService.changePassword({
          userId: user._id.toString(),
          currentPassword: 'wrong-current-password',
          newPassword: 'new-password'
        }),
        (err) => err.code === 'VALIDATION_ERROR'
      );
    });

    test('invalidates EVERY refresh session, including the one used to make the request', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'old-password' });
      const sessionA = await authService.login({ username: 'shopowner', password: 'old-password', userAgent: 'device-a' });
      const sessionB = await authService.login({ username: 'shopowner', password: 'old-password', userAgent: 'device-b' });

      await authService.changePassword({
        userId: user._id.toString(),
        currentPassword: 'old-password',
        newPassword: 'new-password'
      });

      const reloaded = await User.findById(user._id);
      assert.equal(reloaded.refreshTokens.length, 0);

      // Both previously-valid sessions must now fail to refresh.
      await assert.rejects(() => authService.refresh({ refreshToken: sessionA.refreshToken, userAgent: 'x' }));
      await assert.rejects(() => authService.refresh({ refreshToken: sessionB.refreshToken, userAgent: 'x' }));
    });

    test('does not issue any replacement tokens', async () => {
      const user = await createTestUser({ username: 'shopowner', password: 'old-password' });
      const result = await authService.changePassword({
        userId: user._id.toString(),
        currentPassword: 'old-password',
        newPassword: 'new-password'
      });
      assert.equal(result, undefined);
    });
  });
});
