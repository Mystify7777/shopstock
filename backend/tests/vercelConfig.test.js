// The root vercel.json: how Vercel Services deploys this repository as one project.
// Pins what the file promises, and that the code it points at keeps those promises:
// the backend entry exists and exports an Express app, and the API lives under /api,
// the prefix Vercel keeps when it forwards a request to the backend service.
//
// That Vercel accepts and applies the file is Vercel's behavior, checked by a real
// deployment, not here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'));

describe('services', () => {
  test('are a backend (Express) and a frontend (Vite), each rooted at a real directory', () => {
    assert.deepEqual(Object.keys(config.services).sort(), ['backend', 'frontend']);
    assert.equal(config.services.backend.framework, 'express');
    assert.equal(config.services.frontend.framework, 'vite');
    for (const service of Object.values(config.services)) {
      assert.ok(statSync(join(repoRoot, service.root)).isDirectory(), `${service.root} is a directory`);
    }
    assert.equal(config.services.backend.root, 'backend');
    assert.equal(config.services.frontend.root, 'frontend');
  });

  test('the backend names its entry explicitly, because the directory also holds server.js, which listens on a port', () => {
    assert.equal(config.services.backend.entrypoint, 'index.js');
    assert.ok(existsSync(join(repoRoot, 'backend', 'index.js')));
    assert.ok(existsSync(join(repoRoot, 'backend', 'server.js')), 'server.js is kept for hosts that run a long-lived process');
  });

  test('the frontend serves its index.html for any path that is not a file, so a deep link survives a reload', () => {
    assert.deepEqual(config.services.frontend.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
  });
});

describe('routing', () => {
  test('/api/* goes to the backend, everything else to the frontend, the catch-all last', () => {
    assert.deepEqual(config.rewrites, [
      { source: '/api/(.*)', destination: { service: 'backend' } },
      { source: '/(.*)', destination: { service: 'frontend' } }
    ]);
  });

  test('every rewrite targets a service that exists', () => {
    for (const rewrite of config.rewrites) assert.ok(config.services[rewrite.destination.service]);
  });

  test('has none of the build or runtime keys that are invalid at the top level when services is present', () => {
    for (const key of ['functions', 'buildCommand', 'installCommand', 'devCommand', 'ignoreCommand', 'outputDirectory', 'framework']) {
      assert.ok(!(key in config), `${key} must live inside a service`);
    }
  });
});

describe('the backend entry', () => {
  test('default-exports an Express app that connects to nothing until it is asked something', async () => {
    const { default: app } = await import('../index.js');
    assert.equal(typeof app, 'function');
    assert.equal(typeof app.use, 'function');
    assert.equal(typeof app.listen, 'function');
  });

  test('the API is under /api, the prefix Vercel keeps when it forwards a request: /api/health answers, /health does not', async () => {
    const { createServerlessApp } = await import('../src/serverless.js');
    const app = createServerlessApp({
      env: {
        MONGODB_URI: 'mongodb://db.example.test:27017/shopstock',
        JWT_ACCESS_SECRET: 'test-secret',
        JWT_ACCESS_EXPIRES_IN: '15m',
        REFRESH_TOKEN_EXPIRES_IN_DAYS: '90',
        SEED_USERNAME: 'shopowner',
        SEED_PASSWORD: 'test-password',
        CORS_ORIGIN: 'https://shop.example.com'
      },
      connect: async () => {},
      isConnected: () => true
    });
    assert.equal((await request(app).get('/api/health')).status, 200);
    assert.equal((await request(app).get('/health')).status, 404);
  });
});
