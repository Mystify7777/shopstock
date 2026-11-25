// TRUST_PROXY unset: nothing changes. Express keeps its default (trust no proxy),
// so a server reached directly behaves exactly as it did before TRUST_PROXY existed.
// That also documents the problem the setting solves: behind a proxy, every client
// is the proxy's address, so everyone shares one login/refresh budget.
//
// Its own file because the limiter's counters are process-wide (see
// trustProxy.test.js); node --test runs each file in its own process.

import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { AUTH_RATE_LIMIT_MAX_REQUESTS } from '../src/middleware/authRateLimiter.js';

const MAX = AUTH_RATE_LIMIT_MAX_REQUESTS;
const servers = [];
let logged;

function start(options = {}) {
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

async function post(port, forwardedFor) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
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

describe('TRUST_PROXY unset', () => {
  test('createApp() leaves Express\'s trust proxy setting at its default (off)', () => {
    assert.equal(start().app.get('trust proxy'), false);
  });

  test('null is the same as unset: loadConfig reports null when TRUST_PROXY is not configured', () => {
    assert.equal(start({ trustProxy: null }).app.get('trust proxy'), false);
  });

  test('X-Forwarded-For is ignored: distinct claimed clients share the real connection\'s one bucket (the behavior is unchanged)', async () => {
    const { port } = start();
    const results = [];
    for (let i = 1; i <= MAX + 3; i += 1) results.push(await post(port, `203.0.113.${i}`));
    assert.deepEqual(results.slice(0, MAX), Array(MAX).fill(400));
    assert.deepEqual(results.slice(MAX), [429, 429, 429]);
  });

  test('a forwarded header with no trusted proxy is reported by the limiter, which is what TRUST_PROXY resolves', async () => {
    await post(start().port, '198.51.100.77'); // the limiter checks its setup on its first request
    assert.ok(logged.some((line) => /X-Forwarded-For/i.test(line)), 'express-rate-limit warns that the header is set but trust proxy is false');
  });
});

describe('TRUST_PROXY=0', () => {
  test('is the explicit form of the same thing: nothing is trusted', async () => {
    const { app } = start({ trustProxy: 0 });
    assert.equal(app.get('trust proxy'), 0);
  });
});
