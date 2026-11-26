// TRUST_PROXY through the serverless wrapper. The wrapper mounts the real app inside
// another Express app, and Express decides req.ip from the app that answers, so this
// checks that the setting still reaches the auth rate limiter: behind Vercel's proxy
// each client must be counted on its own, and one client must still be limited.
//
// Its own file because the limiter's counters are process-wide (see trustProxy.test.js).

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServerlessApp } from '../src/serverless.js';
import { AUTH_RATE_LIMIT_MAX_REQUESTS } from '../src/middleware/authRateLimiter.js';

const MAX = AUTH_RATE_LIMIT_MAX_REQUESTS;
let server;
let port;

before(async () => {
  mock.method(console, 'error', () => {});
  const app = createServerlessApp({
    env: {
      MONGODB_URI: 'mongodb://db.example.test:27017/shopstock',
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-secret',
      JWT_ACCESS_EXPIRES_IN: '15m',
      REFRESH_TOKEN_EXPIRES_IN_DAYS: '90',
      SEED_USERNAME: 'shopowner',
      SEED_PASSWORD: 'test-password',
      CORS_ORIGIN: 'https://shop.example.com',
      TRUST_PROXY: '1'
    },
    connect: async () => {},
    isConnected: () => true
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});
after(() => {
  mock.restoreAll();
  server.close();
});

async function post(forwardedFor) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: '{}'
  });
  return response.status;
}

test('different clients behind the proxy are counted separately', async () => {
  const statuses = new Set();
  for (let i = 1; i <= MAX * 3; i += 1) statuses.add(await post(`198.51.100.${i}`));
  assert.deepEqual([...statuses], [400], 'every client is answered by the route; none is rate limited');
});

test(`one client is still limited after ${MAX} attempts`, async () => {
  const results = [];
  for (let i = 1; i <= MAX + 2; i += 1) results.push(await post('203.0.113.77'));
  assert.deepEqual(results.slice(MAX), [429, 429]);
  assert.equal(await post('203.0.113.78'), 400, 'a neighbour is unaffected');
});
