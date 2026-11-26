// src/serverless.js: the API as a serverless function. Run without a database: the
// MongoDB connection is injected, and the real createApp() answers the requests.
//
// What is pinned: the connection is opened on demand, shared, reused and retried;
// a bad environment or a failed connection answers with the standard 500 and never
// exits the process; and nothing sensitive reaches a response or a log line.

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServerlessApp, SERVERLESS_MAX_POOL_SIZE } from '../src/serverless.js';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'pa55w0rd-must-never-appear';

function completeEnv(overrides = {}) {
  return {
    MONGODB_URI: `mongodb://shopuser:${PASSWORD}@db.example.test:27017/shopstock`,
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'test-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_IN_DAYS: '90',
    SEED_USERNAME: 'shopowner',
    SEED_PASSWORD: 'test-password',
    CORS_ORIGIN: ORIGIN,
    ...overrides
  };
}

// A stand-in for the database: `connected` is what isConnected() reports, and a
// successful connect() flips it, as the real driver does.
function fakeDb({ failTimes = 0, delayMs = 0, errorMessage = 'connect failed' } = {}) {
  const db = {
    connected: false,
    calls: [],
    failuresLeft: failTimes,
    connect: async (uri, options) => {
      db.calls.push({ uri, options });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (db.failuresLeft > 0) {
        db.failuresLeft -= 1;
        throw Object.assign(new Error(errorMessage), { name: 'MongoServerSelectionError' });
      }
      db.connected = true;
    },
    isConnected: () => db.connected
  };
  return db;
}

let logged;
let exitCalls;
beforeEach(() => {
  logged = [];
  exitCalls = 0;
  mock.method(console, 'error', (...args) => logged.push(args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(' ')));
  mock.method(process, 'exit', () => {
    exitCalls += 1;
  });
});
afterEach(() => mock.restoreAll());

const serve = (db, extra = {}) => createServerlessApp({ env: completeEnv(), connect: db.connect, isConnected: db.isConnected, ...extra });

describe('the connection: on demand, shared, reused, retried', () => {
  test('is opened by the first request, with the configured URI and a small pool, and reused after', async () => {
    const db = fakeDb();
    const app = serve(db);
    assert.equal(db.calls.length, 0, 'nothing connects before a request');
    for (let i = 0; i < 4; i += 1) assert.equal((await request(app).get('/api/health')).status, 200);
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].uri, completeEnv().MONGODB_URI);
    assert.deepEqual(db.calls[0].options, { maxPoolSize: SERVERLESS_MAX_POOL_SIZE });
    assert.ok(SERVERLESS_MAX_POOL_SIZE <= 10, 'a pool per instance must stay small');
  });

  test('requests that arrive together share one attempt', async () => {
    const db = fakeDb({ delayMs: 60 });
    const app = serve(db);
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).get('/api/nope')));
    assert.deepEqual(new Set(responses.map((r) => r.status)), new Set([404]));
    assert.equal(db.calls.length, 1);
  });

  test('a dropped connection is reopened by the next request', async () => {
    const db = fakeDb();
    const app = serve(db);
    await request(app).get('/api/nope');
    db.connected = false;
    await request(app).get('/api/nope');
    assert.equal(db.calls.length, 2);
  });

  test('a failed attempt is retried by the next request, not remembered', async () => {
    const db = fakeDb({ failTimes: 1 });
    const app = serve(db);
    assert.equal((await request(app).get('/api/nope')).status, 500);
    assert.equal((await request(app).get('/api/nope')).status, 404, 'the second request connects and reaches the real app');
    assert.equal(db.calls.length, 2);
  });

  test('the pool size can be overridden', async () => {
    const db = fakeDb();
    await request(serve(db, { maxPoolSize: 3 })).get('/api/health');
    assert.deepEqual(db.calls[0].options, { maxPoolSize: 3 });
  });
});

describe('a failed connection', () => {
  test('answers with the standard 500 and no detail, and never exits the process', async () => {
    const db = fakeDb({ failTimes: 5 });
    const response = await request(serve(db)).get('/api/nope');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    assert.equal(exitCalls, 0);
  });

  test('puts no credential in the response or the log, even when the driver echoes the connection string', async () => {
    const uri = completeEnv().MONGODB_URI;
    const db = fakeDb({ failTimes: 5, errorMessage: `bad auth for ${uri} and also //other:${PASSWORD}@elsewhere` });
    const response = await request(serve(db)).get('/api/nope');
    assert.ok(!JSON.stringify(response.body).includes(PASSWORD));
    const log = logged.join('\n');
    assert.ok(log.includes('Could not connect to MongoDB'), 'the failure is logged');
    assert.ok(!log.includes(PASSWORD), 'the password must not appear in the log');
    assert.ok(!log.includes(uri), 'the connection string must not appear in the log');
  });

  test('the health check still answers 200: it reports the database state and never fails because of it', async () => {
    const db = fakeDb({ failTimes: 5 });
    const response = await request(serve(db)).get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(db.calls.length, 1, 'it did try to connect');
  });
});

describe('a CORS preflight', () => {
  test('is answered without waiting for the database', async () => {
    const db = fakeDb({ failTimes: 5 });
    const response = await request(serve(db))
      .options('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(db.calls.length, 0);
  });
});

describe('the environment', () => {
  test('is read on the first request, and the real app is built once', async () => {
    const db = fakeDb();
    let built = 0;
    const app = serve(db, { buildApp: (options) => { built += 1; return (req, res) => res.status(200).json({ ok: true, corsOrigin: options.corsOrigin, trustProxy: options.trustProxy }); } });
    assert.equal(built, 0, 'nothing is built until a request');
    await request(app).get('/a');
    await request(app).get('/b');
    assert.equal(built, 1);
  });

  test('is passed to the app exactly as loadConfig would: CORS origins, TRUST_PROXY, token settings', async () => {
    const db = fakeDb();
    let received;
    const app = serve(db, { env: completeEnv({ CORS_ORIGIN: `${ORIGIN},https://shop.example.com`, TRUST_PROXY: '1' }), buildApp: (options) => { received = options; return (req, res) => res.end(); } });
    await request(app).get('/x');
    assert.deepEqual(received, {
      corsOrigin: [ORIGIN, 'https://shop.example.com'],
      trustProxy: 1,
      jwtAccessSecret: 'test-secret',
      jwtAccessExpiresIn: '15m',
      refreshTokenExpiresInDays: 90
    });
  });

  test('a missing variable answers 500, is logged by NAME only, never exits, and never connects', async () => {
    const env = completeEnv();
    delete env.JWT_ACCESS_SECRET;
    const db = fakeDb();
    const response = await request(createServerlessApp({ env, connect: db.connect, isConnected: db.isConnected })).get('/api/nope');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    const log = logged.join('\n');
    assert.match(log, /missing required environment variable\(s\): JWT_ACCESS_SECRET/);
    assert.ok(!log.includes(PASSWORD) && !log.includes('test-password'), 'no value is logged');
    assert.equal(exitCalls, 0);
    assert.equal(db.calls.length, 0);
  });

  test('in production a placeholder secret is refused, by name and with what is required, without printing it', async () => {
    const placeholder = 'change-me-to-a-long-random-string';
    const env = completeEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: placeholder });
    const response = await request(createServerlessApp({ env, connect: fakeDb().connect })).get('/api/health');
    assert.equal(response.status, 500);
    const log = logged.join('\n');
    assert.match(log, /JWT_ACCESS_SECRET \(in production it must be at least 32 characters/);
    assert.ok(!log.includes(placeholder));
    assert.equal(exitCalls, 0);
  });

  test('is checked again on the next request, so fixing the setting needs no restart', async () => {
    const env = completeEnv({ CORS_ORIGIN: '*' });
    const db = fakeDb();
    const app = createServerlessApp({ env, connect: db.connect, isConnected: db.isConnected });
    assert.equal((await request(app).get('/api/health')).status, 500);
    env.CORS_ORIGIN = ORIGIN;
    assert.equal((await request(app).get('/api/health')).status, 200);
  });
});

describe('what a request reaches', () => {
  test('the real app, at the path the host forwards (the /api prefix is kept)', async () => {
    const db = fakeDb();
    const app = serve(db);
    const health = await request(app).get('/api/health');
    assert.deepEqual(Object.keys(health.body).sort(), ['db', 'status']);
    const missing = await request(app).get('/api/no-such-route');
    assert.deepEqual(missing.body, { error: { code: 'NOT_FOUND', message: 'No route matches this request.' } });
  });

  test('protected routes are still protected', async () => {
    const response = await request(serve(fakeDb())).get('/api/products');
    assert.equal(response.status, 401);
  });
});
