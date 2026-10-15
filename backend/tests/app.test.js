import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { AppError } from '../src/middleware/AppError.js';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js';
import { captureUnhandledErrorLog } from './helpers/captureUnhandledErrorLog.js';

describe('GET /api/health', () => {
  test('responds 200 with status ok, no auth required', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('reports db connection state as a separate field, and does not fail the request when db is disconnected', async () => {
    // No connectDb() call has happened anywhere in this test file -- the
    // Mongoose connection is genuinely disconnected here. The health
    // endpoint must still return 200; a health check that fails outright
    // because the DB happens to be down is exactly the cascading-outage
    // pattern the endpoint's own design comment warns against.
    const app = createApp();
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.db, 'disconnected');
  });
});

describe('unmatched routes', () => {
  test('an unknown path returns 404 with the locked error shape', async () => {
    const app = createApp();
    const res = await request(app).get('/api/this-route-does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.equal(typeof res.body.error.message, 'string');
  });
});

describe('centralized error handling', () => {
  // These exercise errorHandler.js directly against a minimal throwaway
  // Express app (rather than createApp(), which has no route that
  // deliberately throws yet) -- this is the correct scope for Phase 5A,
  // since no domain routes exist yet to throw a real AppError from.
  function appWithThrowingRoute(errorToThrow) {
    const app = express();
    app.get('/throws', (req, res, next) => {
      next(errorToThrow);
    });
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  }

  test('an AppError is translated into the locked { error: { code, message } } shape with its own status', async (t) => {
    const logged = captureUnhandledErrorLog(t);
    const app = appWithThrowingRoute(new AppError('CONFLICT', 'Already exists.'));
    const res = await request(app).get('/throws');
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: { code: 'CONFLICT', message: 'Already exists.' } });
    assert.equal(logged.length, 0, 'an anticipated AppError is not an "unhandled" error and is not logged as one');
  });

  test('a non-AppError exception is reported as INTERNAL_ERROR with a generic message, never leaking the real error text', async (t) => {
    const logged = captureUnhandledErrorLog(t);
    const thrown = new Error('some sensitive stack-trace detail');
    const app = appWithThrowingRoute(thrown);
    const res = await request(app).get('/throws');
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(res.body.error.message, /sensitive stack-trace detail/);
    assert.doesNotMatch(JSON.stringify(res.body), /sensitive stack-trace detail/);
    // The real detail goes to the server log (production diagnostic), once.
    assert.equal(logged.length, 1);
    assert.equal(logged[0], thrown);
  });

  test('every error response uses the exact same top-level shape: { error: { code, message } }', async (t) => {
    const logged = captureUnhandledErrorLog(t);
    const app = appWithThrowingRoute(new AppError('VALIDATION_ERROR', 'Bad input.'));
    const res = await request(app).get('/throws');
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']);
    assert.equal(logged.length, 0, 'an anticipated AppError is not logged as an unhandled error');
  });
});

describe('CORS', () => {
  test('createApp() with no corsOrigin option defaults to disallowing cross-origin requests', async () => {
    const app = createApp(); // no corsOrigin passed
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example.com');
    // cors() with origin:false omits Access-Control-Allow-Origin entirely
    // rather than echoing back the request's Origin header.
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('createApp() with an explicit corsOrigin allows that origin', async () => {
    const app = createApp({ corsOrigin: 'http://localhost:5173' });
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  });
});
