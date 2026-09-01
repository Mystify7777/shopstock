// Auth route tests that do NOT require MongoDB -- these exercise the
// validation-before-any-DB-call paths (authController.js's own presence/
// type checks throw an AppError before authService is ever invoked), the
// requireAuth-protected route's 401 behavior for a missing/invalid
// token, and rate-limit header presence. Genuinely runnable in this
// sandbox; the success paths (real login/refresh/logout/password-change
// against a persisted user) are Mongo-dependent and live in
// tests/services/authService.test.js instead, which is NOT executed
// here -- see that file's header comment.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { AUTH_RATE_LIMIT_MAX_REQUESTS } from '../src/middleware/authRateLimiter.js';

// This file deliberately never calls connectDb() (it exercises only the
// validation-before-any-DB-call paths and 401 behavior, not real
// persistence) -- but authController.js's non-validation-error code
// paths still attempt a Mongoose query when a request happens to pass
// validation, and without an active connection, Mongoose's default
// command buffering would otherwise wait up to its full timeout (10s)
// before surfacing an error, making every such test slow without adding
// any real signal. Setting bufferCommands: false here makes those calls
// fail immediately instead -- mirroring the same fail-fast principle
// config/db.js's connectDb() already applies for the real connected
// case; this is the equivalent for the deliberately-disconnected test
// case.
mongoose.set('bufferCommands', false);

const AUTH_CONFIG = {
  jwtAccessSecret: 'test-secret',
  jwtAccessExpiresIn: '15m',
  refreshTokenExpiresInDays: 90
};

function testApp() {
  return createApp(AUTH_CONFIG);
}

describe('POST /api/auth/login validation', () => {
  test('rejects a request with no body', async () => {
    const res = await request(testApp()).post('/api/auth/login').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('rejects a request missing password', async () => {
    const res = await request(testApp()).post('/api/auth/login').send({ username: 'shopowner' });
    assert.equal(res.status, 400);
  });

  test('rejects a request missing username', async () => {
    const res = await request(testApp()).post('/api/auth/login').send({ password: 'x' });
    assert.equal(res.status, 400);
  });

  test('rejects a non-string username', async () => {
    const res = await request(testApp()).post('/api/auth/login').send({ username: 123, password: 'x' });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/auth/refresh validation', () => {
  test('rejects a request with no refreshToken', async () => {
    const res = await request(testApp()).post('/api/auth/refresh').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('POST /api/auth/logout validation', () => {
  test('rejects a request with no refreshToken', async () => {
    const res = await request(testApp()).post('/api/auth/logout').send({});
    assert.equal(res.status, 400);
  });

  test('does NOT require an Authorization header (locked contract)', async () => {
    // A syntactically-present-but-never-issued refreshToken -- this
    // still exercises "no Authorization header required" even though
    // the actual revoke-if-exists behavior needs Mongo and is tested in
    // authService.test.js. What's being confirmed here is that the
    // request reaches the controller/service layer at all (i.e. is not
    // rejected by an auth-required middleware) without any
    // Authorization header -- if requireAuth were incorrectly applied
    // to this route, this request would fail with 401 before ever
    // reaching Mongo, and this test would need MongoDB purely to prove
    // a negative. Instead: no Authorization header is sent, and the
    // request must NOT be rejected with 401 (UNAUTHORIZED) -- it may
    // still fail later for Mongo-connectivity reasons in this sandbox,
    // but it must not fail with the wrong error code.
    const res = await request(testApp()).post('/api/auth/logout').send({ refreshToken: 'x'.repeat(64) });
    assert.notEqual(res.status, 401);
  });
});

describe('PATCH /api/auth/password requires a valid access token', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await request(testApp())
      .patch('/api/auth/password')
      .send({ currentPassword: 'a', newPassword: 'b' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  test('rejects a request with an invalid access token', async () => {
    const res = await request(testApp())
      .patch('/api/auth/password')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ currentPassword: 'a', newPassword: 'b' });
    assert.equal(res.status, 401);
  });
});

describe('auth rate limiting', () => {
  test('login responses include standard rate-limit headers', async () => {
    const res = await request(testApp()).post('/api/auth/login').send({ username: 'x', password: 'y' });
    assert.ok(res.headers['ratelimit-limit'] !== undefined || res.headers['x-ratelimit-limit'] !== undefined);
  });

  test('/logout is NOT rate-limited (no rate-limit headers)', async () => {
    const res = await request(testApp()).post('/api/auth/logout').send({ refreshToken: 'x'.repeat(64) });
    assert.equal(res.headers['ratelimit-limit'], undefined);
    assert.equal(res.headers['x-ratelimit-limit'], undefined);
  });

  test('exceeding the limit responds 429 with the RATE_LIMITED code, not VALIDATION_ERROR', async () => {
    // Uses a shared app instance (not testApp() per request) since
    // express-rate-limit's store is per-instance -- a fresh app via
    // testApp() would reset the counter on every call.
    const app = testApp();
    let lastRes;
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX_REQUESTS + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- requests must be
      // sequential against the same limiter instance to reliably exceed
      // the count; concurrency here would not change the outcome but
      // adds no value either.
      lastRes = await request(app).post('/api/auth/login').send({ username: 'x', password: 'y' });
    }
    assert.equal(lastRes.status, 429);
    assert.equal(lastRes.body.error.code, 'RATE_LIMITED');
  });
});
