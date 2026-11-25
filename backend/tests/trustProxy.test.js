// TRUST_PROXY, configured: behind a hosting proxy the auth rate limiter (login and
// refresh) must count each client on its own, not count everyone as the proxy.
//
// The limiter is one module-level instance, so its counters live for the whole test
// process. Every case therefore uses its own client addresses, and the "unset" case
// (shared counter) lives in trustProxyUnset.test.js, which node --test runs in a
// separate process.
//
// No database is needed: the limiter runs before any route logic, and an empty body
// is rejected by validation (400) before anything is read.

import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { AUTH_RATE_LIMIT_MAX_REQUESTS } from '../src/middleware/authRateLimiter.js';

const MAX = AUTH_RATE_LIMIT_MAX_REQUESTS;
const servers = [];
let logged;

function start(options) {
  const app = createApp({
    corsOrigin: ['https://shop.example.test'],
    jwtAccessSecret: 'x'.repeat(32),
    jwtAccessExpiresIn: '15m',
    refreshTokenExpiresInDays: 90,
    ...options
  });
  const server = app.listen(0);
  servers.push(server);
  return { app, port: server.address().port };
}

// One request, claiming to come from `forwardedFor` (what a proxy would add).
async function post(port, forwardedFor, path = 'login') {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: '{}'
  });
  return response.status;
}

before(() => {
  logged = [];
  mock.method(console, 'error', (...args) => logged.push(args.map(String).join(' ')));
});
after(() => {
  mock.restoreAll();
  for (const server of servers) server.close();
});

describe('TRUST_PROXY=1 (one proxy in front)', () => {
  test('the app trusts exactly that many hops', () => {
    const { app } = start({ trustProxy: 1 });
    assert.equal(app.get('trust proxy'), 1);
  });

  test('separate forwarded client addresses get separate buckets: many different clients are never limited', async () => {
    const { port } = start({ trustProxy: 1 });
    const statuses = new Set();
    for (let i = 1; i <= MAX * 4; i += 1) statuses.add(await post(port, `198.51.100.${i}`));
    assert.deepEqual([...statuses], [400], 'every client is answered by the route (400: empty body), none is rate limited');
  });

  test(`one client is still limited after ${MAX} attempts, and its neighbours are not`, async () => {
    const { port } = start({ trustProxy: 1 });
    const results = [];
    for (let i = 1; i <= MAX + 2; i += 1) results.push(await post(port, '203.0.113.200'));
    assert.deepEqual(results.slice(0, MAX), Array(MAX).fill(400));
    assert.deepEqual(results.slice(MAX), [429, 429]);
    assert.equal(await post(port, '203.0.113.201'), 400, 'a different client is unaffected');
  });

  test('the limited response keeps its existing shape', async () => {
    const { port } = start({ trustProxy: 1 });
    for (let i = 0; i < MAX; i += 1) await post(port, '203.0.113.210');
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.210' },
      body: '{}'
    });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } });
  });

  test('a client cannot dodge the limit by forging earlier X-Forwarded-For entries: the proxy-added one counts', async () => {
    const { port } = start({ trustProxy: 1 });
    const results = [];
    for (let i = 1; i <= MAX + 2; i += 1) results.push(await post(port, `192.0.2.${i}, 203.0.113.99`));
    assert.deepEqual(results.slice(MAX), [429, 429]);
  });

  test('login and refresh share one budget per client, as before', async () => {
    const { port } = start({ trustProxy: 1 });
    const results = [];
    for (let i = 0; i < MAX / 2 + 1; i += 1) {
      results.push(await post(port, '203.0.113.150', 'login'));
      results.push(await post(port, '203.0.113.150', 'refresh'));
    }
    assert.equal(results.filter((status) => status === 429).length, results.length - MAX);
    assert.notEqual(await post(port, '203.0.113.151', 'refresh'), 429, 'another client can still refresh');
  });

  test('configured correctly, the limiter raises no X-Forwarded-For validation error', async () => {
    const { port } = start({ trustProxy: 1 });
    await post(port, '198.51.100.250');
    assert.deepEqual(logged.filter((line) => /X-Forwarded-For/i.test(line)), []);
  });

  test('a larger hop count is honored: with 2 proxies the second-from-last entry is the client', async () => {
    const { app, port } = start({ trustProxy: 2 });
    assert.equal(app.get('trust proxy'), 2);
    const results = [];
    // Last entry is the nearest proxy and constant; the client is the one before it.
    for (let i = 1; i <= MAX * 2; i += 1) results.push(await post(port, `198.51.100.${100 + i}, 10.0.0.1`));
    assert.deepEqual([...new Set(results)], [400], 'distinct clients behind a constant proxy are separate buckets');
  });
});
