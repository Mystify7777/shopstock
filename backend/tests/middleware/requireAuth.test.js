import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { requireAuth } from '../../src/middleware/requireAuth.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { signAccessToken } from '../../src/services/tokenService.js';

const SECRET = 'test-secret';

function appWithProtectedRoute() {
  const app = express();
  app.get('/protected', requireAuth({ secret: SECRET }), (req, res) => {
    res.json({ userId: req.user.id });
  });
  app.use(errorHandler);
  return app;
}

describe('requireAuth', () => {
  test('rejects a request with no Authorization header', async () => {
    const app = appWithProtectedRoute();
    const res = await request(app).get('/protected');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  test('rejects a request with a malformed Authorization header (no Bearer prefix)', async () => {
    const app = appWithProtectedRoute();
    const res = await request(app).get('/protected').set('Authorization', 'not-a-bearer-token');
    assert.equal(res.status, 401);
  });

  test('rejects a request with an invalid/garbage token', async () => {
    const app = appWithProtectedRoute();
    const res = await request(app).get('/protected').set('Authorization', 'Bearer garbage.token.value');
    assert.equal(res.status, 401);
  });

  test('rejects a request with an expired token', async () => {
    const app = appWithProtectedRoute();
    const expiredToken = signAccessToken({ userId: 'user-1', secret: SECRET, expiresIn: '1ms' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    assert.equal(res.status, 401);
  });

  test('rejects a token signed with a different secret', async () => {
    const app = appWithProtectedRoute();
    const wrongSecretToken = signAccessToken({ userId: 'user-1', secret: 'a-different-secret', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${wrongSecretToken}`);
    assert.equal(res.status, 401);
  });

  test('allows a request with a valid token and attaches req.user.id', async () => {
    const app = appWithProtectedRoute();
    const token = signAccessToken({ userId: 'user-42', secret: SECRET, expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, 'user-42');
  });

  test('the 401 error message never echoes back the token that was rejected', async () => {
    const app = appWithProtectedRoute();
    const secretToken = 'super-secret-token-fragment-xyz';
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${secretToken}`);
    assert.equal(res.status, 401);
    assert.doesNotMatch(JSON.stringify(res.body), /super-secret-token-fragment-xyz/);
  });
});
