// Auth route tests that do NOT require MongoDB.
//
// Two kinds of test live here, and neither touches a database:
//
//   1. Through the real createApp(): requests that are rejected BEFORE
//      authService is ever invoked (the controller's own presence/type
//      checks) and the requireAuth-protected route's 401s.
//   2. Through the real auth router, controller, rate limiter and error
//      handler with a STUB authService, for everything that gets past
//      validation (the locked "logout needs no Authorization header"
//      contract, rate limiting, and how an unexpected service failure is
//      reported). The stub means these requests never reach Mongoose, so
//      nothing here depends on, or is slowed by, a missing connection.
//
// The real login/refresh/logout/password-change logic against a persisted
// user is Mongo-dependent and lives in tests/services/authService.test.js.
//
// RATE-LIMIT ISOLATION. authRateLimiter is ONE module-level instance shared
// by every app in this process and keyed by client IP. Only /login and
// /refresh pass through it. So:
//   - every test that reaches those routes does so through client(), which
//     gives it its own IP (and therefore its own counter);
//   - the only tests that share an IP deliberately are the two that verify
//     CUMULATIVE limiting, and they say so;
//   - createApp() is used only for requests that never reach the limiter
//     (/logout validation, PATCH /password), where it still proves the router
//     is mounted at /api/auth.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { createAuthRouter } from '../src/routes/authRoutes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { AUTH_RATE_LIMIT_MAX_REQUESTS } from '../src/middleware/authRateLimiter.js';
import { captureUnhandledErrorLog } from './helpers/captureUnhandledErrorLog.js';

// This file never connects to MongoDB, and no test here should ever reach
// it. As a guard: if one accidentally did, Mongoose's default command
// buffering would wait its full timeout (10s) before failing. With
// bufferCommands: false such a call fails immediately instead, so a
// regression shows up as a fast, obvious failure rather than a slow one.
mongoose.set('bufferCommands', false);

const AUTH_CONFIG = {
  jwtAccessSecret: 'test-secret',
  jwtAccessExpiresIn: '15m',
  refreshTokenExpiresInDays: 90
};

// Only for requests that never reach the rate limiter (see header).
function testApp() {
  return createApp(AUTH_CONFIG);
}

// ---- stub-service app -------------------------------------------------------

/** A stand-in authService that records its calls and never touches a database. */
function stubAuthService(overrides = {}) {
  const calls = { login: [], refresh: [], logout: [], changePassword: [] };
  const service = {
    login: async (args) => {
      calls.login.push(args);
      return { accessToken: 'access-token', refreshToken: 'r'.repeat(64) };
    },
    refresh: async (args) => {
      calls.refresh.push(args);
      return { accessToken: 'access-token-2', refreshToken: 'q'.repeat(64) };
    },
    logout: async (args) => {
      calls.logout.push(args);
    },
    changePassword: async (args) => {
      calls.changePassword.push(args);
    },
    ...overrides
  };
  return { service, calls };
}

// The real auth router, controller, rate limiter and error handler around a
// given service. Mirrors how createApp() assembles them (json body parser,
// router at /api/auth, error handler last).
//
// Supertest connects from loopback. Trusting loopback proxies lets a request
// choose its client IP through X-Forwarded-For -- that is what client() does.
// The first middleware refuses any request that did NOT go through client(),
// so a test cannot silently fall back to the shared default key.
function routerApp(service) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use((req, _res, next) => {
    if (!req.get('x-forwarded-for')) {
      return next(new Error('routerApp requests must be sent through client() so each test gets its own rate-limit key.'));
    }
    return next();
  });
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(service, AUTH_CONFIG));
  app.use(errorHandler);
  return app;
}

let nextClientOctet = 0;
/** A fresh documentation-range (TEST-NET-3) address, unique within this file. */
function uniqueClientIp() {
  nextClientOctet += 1;
  return `203.0.113.${nextClientOctet}`;
}

/**
 * A client with its own IP. Called with just an app, it gets a fresh IP, so
 * ordinary tests can never inherit another test's rate-limit counter. Pass an
 * explicit `ip` only to share one counter ON PURPOSE across several requests.
 */
function client(app, ip = uniqueClientIp()) {
  return {
    ip,
    post: (path, body) => request(app).post(path).set('X-Forwarded-For', ip).send(body)
  };
}

const LOGOUT_BODY = { refreshToken: 'x'.repeat(64) };
const NO_CALLS = { login: [], refresh: [], logout: [], changePassword: [] };

describe('POST /api/auth/login validation', () => {
  for (const [label, body] of [
    ['a request with no body', {}],
    ['a request missing password', { username: 'shopowner' }],
    ['a request missing username', { password: 'x' }],
    ['a non-string username', { username: 123, password: 'x' }]
  ]) {
    test(`rejects ${label}, before the service is reached`, async () => {
      const { service, calls } = stubAuthService();
      const res = await client(routerApp(service)).post('/api/auth/login', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(calls, NO_CALLS);
    });
  }
});

describe('POST /api/auth/refresh validation', () => {
  test('rejects a request with no refreshToken, before the service is reached', async () => {
    const { service, calls } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/refresh', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(calls, NO_CALLS);
  });
});

describe('POST /api/auth/logout validation', () => {
  test('rejects a request with no refreshToken (through the real createApp mount)', async () => {
    // /logout never reaches the rate limiter, so the real app is safe to use.
    const res = await request(testApp()).post('/api/auth/logout').send({});
    assert.equal(res.status, 400);
  });

  test('rejects a request with no refreshToken before the service is reached', async () => {
    const { service, calls } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/logout', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(calls, NO_CALLS);
  });

  test('does NOT require an Authorization header (locked contract)', async () => {
    // Locked contract: logout takes no access token. With a stub service the
    // request can be followed all the way through: it must reach the service
    // with the refresh token it sent, and succeed -- not be turned away by
    // an auth-required middleware (which would be a 401).
    const { service, calls } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/logout', LOGOUT_BODY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });
    assert.deepEqual(calls.logout, [{ refreshToken: LOGOUT_BODY.refreshToken }]);
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

describe('isolation guard', () => {
  test('a request that bypasses client() is refused, so it cannot fall back to the shared default key', async (t) => {
    const logged = captureUnhandledErrorLog(t);
    const { service, calls } = stubAuthService();
    const res = await request(routerApp(service)).post('/api/auth/login').send({ username: 'x', password: 'y' });
    assert.equal(res.status, 500);
    assert.deepEqual(calls, NO_CALLS);
    assert.equal(logged.length, 1);
    assert.match(logged[0].message, /through client\(\)/);
  });
});

describe('auth rate limiting', () => {
  test('a login response carries the standard rate-limit headers, and the request reached the service', async () => {
    const { service, calls } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/login', {
      username: 'shopowner',
      password: 'secret'
    });

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['accessToken', 'refreshToken']);
    assert.deepEqual(
      calls.login.map(({ username, password }) => ({ username, password })),
      [{ username: 'shopowner', password: 'secret' }]
    );
    assert.equal(res.headers['ratelimit-limit'], String(AUTH_RATE_LIMIT_MAX_REQUESTS));
    // Fresh client => this is its first counted request. Only true because
    // the test cannot inherit another test's count.
    assert.equal(res.headers['ratelimit-remaining'], String(AUTH_RATE_LIMIT_MAX_REQUESTS - 1));
  });

  test('/logout is NOT rate-limited (no rate-limit headers), and still reaches the service', async () => {
    const { service, calls } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/logout', LOGOUT_BODY);

    assert.equal(res.status, 200);
    assert.equal(calls.logout.length, 1);
    assert.equal(res.headers['ratelimit-limit'], undefined);
    assert.equal(res.headers['x-ratelimit-limit'], undefined);
  });

  test('/refresh is rate-limited too (it shares the limiter with /login)', async () => {
    const { service } = stubAuthService();
    const res = await client(routerApp(service)).post('/api/auth/refresh', LOGOUT_BODY);
    assert.equal(res.status, 200);
    assert.equal(res.headers['ratelimit-limit'], String(AUTH_RATE_LIMIT_MAX_REQUESTS));
  });

  // ---- the two tests below SHARE one IP on purpose: they verify cumulative limiting ----

  test('CUMULATIVE (one shared IP): exactly the limit is allowed; the next request is 429 RATE_LIMITED and never reaches the service', async () => {
    const { service, calls } = stubAuthService();
    const sharedClient = client(routerApp(service)); // one IP for all requests below, deliberately
    const attempt = () => sharedClient.post('/api/auth/login', { username: 'x', password: 'y' });

    for (let i = 1; i <= AUTH_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      // Sequential on purpose: the count must be reached one request at a time.
      // eslint-disable-next-line no-await-in-loop
      const res = await attempt();
      assert.equal(res.status, 200, `request ${i} of ${AUTH_RATE_LIMIT_MAX_REQUESTS} is within the limit`);
    }
    assert.equal(calls.login.length, AUTH_RATE_LIMIT_MAX_REQUESTS);

    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, {
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }
    });
    assert.equal(calls.login.length, AUTH_RATE_LIMIT_MAX_REQUESTS, 'a blocked request must not reach the service');
  });

  test('CUMULATIVE (one shared IP) but PER CLIENT: a blocked IP does not block a different one', async () => {
    const { service } = stubAuthService();
    const app = routerApp(service);
    const noisy = client(app); // deliberately reused to exhaust its own counter
    const quiet = client(app); // a different, fresh client

    for (let i = 0; i <= AUTH_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await noisy.post('/api/auth/login', { username: 'x', password: 'y' });
    }
    const noisyAgain = await noisy.post('/api/auth/login', { username: 'x', password: 'y' });
    const quietFirst = await quiet.post('/api/auth/login', { username: 'x', password: 'y' });

    assert.notEqual(noisy.ip, quiet.ip);
    assert.equal(noisyAgain.status, 429);
    assert.equal(quietFirst.status, 200);
  });
});

describe('an unexpected service failure (for example the database being unavailable)', () => {
  // This is the behaviour the old tests were reaching by accident: with no
  // database connection, the real service throws a Mongoose error. It is
  // pinned here on purpose, with a stub that throws the same kind of error.
  const databaseError = () => {
    const error = new Error(
      'Cannot call `users.findOne()` before initial connection is complete if `bufferCommands = false`.'
    );
    error.name = 'MongooseError';
    return error;
  };

  for (const [label, path, body, method] of [
    ['login', '/api/auth/login', { username: 'shopowner', password: 'secret' }, 'login'],
    ['logout', '/api/auth/logout', LOGOUT_BODY, 'logout']
  ]) {
    test(`${label}: responds INTERNAL_ERROR without leaking the cause, and logs the real error once`, async (t) => {
      const logged = captureUnhandledErrorLog(t);
      const thrown = databaseError();
      const { service } = stubAuthService({
        [method]: async () => {
          throw thrown;
        }
      });

      const res = await client(routerApp(service)).post(path, body);

      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
      assert.doesNotMatch(JSON.stringify(res.body), /findOne|Mongoose|bufferCommands|users/);
      // The server-side diagnostic is preserved (production behaviour).
      assert.equal(logged.length, 1);
      assert.equal(logged[0], thrown);
    });
  }
});
