// NOT EXECUTED IN THIS SANDBOX -- see backend/README.md and
// docs/PROGRESS.md's Phase 5B entry. This file requires a real MongoDB
// connection via tests/helpers/testDb.js's MongoMemoryReplSet, which
// cannot download its binary in this development sandbox (network
// allowlist does not include fastdl.mongodb.org). Written to the locked
// Phase 5C contract and reasoned through carefully, but must be run for
// real -- locally, or in an environment with the necessary network
// access -- before this slice's completion gate can be honestly
// claimed. This is the "prove the pattern once, end-to-end" file for
// Phase 5C: categories is the first resource built, and
// locationRoutes.test.js / tagRoutes.test.js / unitRoutes.test.js
// mirror this file's structure once the pattern is confirmed sound.
//
// Covers, per the Phase 5C authorization:
//   Listing:    authenticated access, unauthenticated rejection,
//               ownership isolation, archived excluded by default,
//               includeArchived=true
//   Upsert:     create, update, idempotency (same id -> one document),
//               URL identity authoritative over a matching/absent body
//               id, a MISMATCHED body id rejected with VALIDATION_ERROR,
//               server-controlled ownerId/updatedAt
//   Validation: empty name, whitespace-only name, invalid boolean
//               fields, malformed payload
//   Ownership:  cross-owner read isolation, cross-owner write isolation,
//               cross-owner id collision on upsert (CONFLICT, not a
//               silent overwrite) -- this last case is the one the
//               Phase 5C review specifically flagged as the "obedient
//               upsert" trap; see classificationService.js's own
//               comment on the (_id, ownerId) filter + duplicate-key
//               handling.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/services/tokenService.js';
import { Category } from '../src/models/classificationModel.js';

const CONFIG = { jwtAccessSecret: 'test-secret' };

function testApp() {
  return createApp(CONFIG);
}

function tokenFor(userId) {
  return signAccessToken({ userId, secret: CONFIG.jwtAccessSecret, expiresIn: '15m' });
}

function authHeader(userId) {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

const OWNER_A = 'owner-a-id';
const OWNER_B = 'owner-b-id';

describe('categories resource', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  describe('GET /api/categories', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).get('/api/categories');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('returns an empty list for a user with no categories', async () => {
      const res = await request(testApp())
        .get('/api/categories')
        .set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('excludes archived categories by default', async () => {
      await Category.create([
        { _id: 'cat-active', ownerId: OWNER_A, name: 'Snacks', archived: false, isDefault: false, updatedAt: new Date() },
        { _id: 'cat-archived', ownerId: OWNER_A, name: 'Old', archived: true, isDefault: false, updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/categories')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0]._id, 'cat-active');
    });

    test('includes archived categories when includeArchived=true', async () => {
      await Category.create([
        { _id: 'cat-active', ownerId: OWNER_A, name: 'Snacks', archived: false, isDefault: false, updatedAt: new Date() },
        { _id: 'cat-archived', ownerId: OWNER_A, name: 'Old', archived: true, isDefault: false, updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/categories?includeArchived=true')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
    });

    test('ownership isolation: owner A cannot see owner B\'s categories', async () => {
      await Category.create({ _id: 'cat-b', ownerId: OWNER_B, name: 'B\'s category', archived: false, isDefault: false, updatedAt: new Date() });

      const res = await request(testApp())
        .get('/api/categories')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });

  describe('PUT /api/categories/:id', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .send({ name: 'Snacks' });
      assert.equal(res.status, 401);
    });

    test('creates a new category', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'cat-1');
      assert.equal(res.body.name, 'Snacks');
      assert.equal(res.body.ownerId, OWNER_A);
      assert.equal(res.body.archived, false);
      assert.equal(res.body.isDefault, false);
      assert.equal(typeof res.body.updatedAt, 'string');

      const stored = await Category.findById('cat-1').lean();
      assert.ok(stored);
      assert.equal(stored.ownerId, OWNER_A);
    });

    test('updates an existing category (idempotent id -> exactly one document)', async () => {
      await request(testApp()).put('/api/categories/cat-1').set(authHeader(OWNER_A)).send({ name: 'Snacks' });
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks & Beverages', archived: true });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Snacks & Beverages');
      assert.equal(res.body.archived, true);

      const count = await Category.countDocuments({ _id: 'cat-1' });
      assert.equal(count, 1);
    });

    test('server sets updatedAt on every write, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks', updatedAt: '2000-01-01T00:00:00.000Z' });

      assert.equal(res.status, 200);
      const returnedYear = new Date(res.body.updatedAt).getFullYear();
      assert.notEqual(returnedYear, 2000);
    });

    test('server sets ownerId from the authenticated user, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks', ownerId: 'attacker-supplied-owner' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ownerId, OWNER_A);
    });

    test('accepts a body.id that matches the URL id', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ id: 'cat-1', name: 'Snacks' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'cat-1');
    });

    test('rejects a body.id that mismatches the URL id with VALIDATION_ERROR', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-a')
        .set(authHeader(OWNER_A))
        .send({ id: 'cat-b', name: 'Electronics' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Category.findById('cat-a').lean();
      assert.equal(stored, null);
    });

    test('rejects an empty name', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: '' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a whitespace-only name', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: '   ' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('trims a valid name with surrounding whitespace', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: '  Snacks  ' });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Snacks');
    });

    test('rejects a non-string name', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 123 });
      assert.equal(res.status, 400);
    });

    test('rejects a non-boolean archived value', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks', archived: 'yes' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-boolean isDefault value', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks', isDefault: 'yes' });
      assert.equal(res.status, 400);
    });

    test('rejects a malformed (non-object) payload', async () => {
      const res = await request(testApp())
        .put('/api/categories/cat-1')
        .set(authHeader(OWNER_A))
        .send([1, 2, 3]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.match(res.body.error.message, /must be an object/i);
    });

    test('ownership isolation: owner A cannot modify owner B\'s category', async () => {
      await Category.create({ _id: 'cat-b', ownerId: OWNER_B, name: 'B\'s category', archived: false, isDefault: false, updatedAt: new Date() });

      const res = await request(testApp())
        .put('/api/categories/cat-b')
        .set(authHeader(OWNER_A))
        .send({ name: 'Hijacked' });

      // The (_id, ownerId) filter matches nothing for owner A, so this
      // is treated as an insert attempt against an _id that already
      // exists -- a duplicate-key collision -> CONFLICT, never a
      // silent overwrite of B's document.
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CONFLICT');

      const stillB = await Category.findById('cat-b').lean();
      assert.equal(stillB.name, 'B\'s category');
      assert.equal(stillB.ownerId, OWNER_B);

      // Explicitly document the invariant, not just infer it: the
      // collision attempt must not have created a second document
      // under any circumstance (_id is a globally unique Mongo primary
      // key, so this is guaranteed in practice, but the test should
      // say so rather than leave it implicit).
      const count = await Category.countDocuments({ _id: 'cat-b' });
      assert.equal(count, 1);
    });

    test('different owners can independently create categories using different ids without interfering with each other', async () => {
      // NOTE: this does NOT test two owners sharing the same _id --
      // that is structurally impossible under this schema (_id is a
      // globally unique Mongo primary key), and is exactly what the
      // cross-owner collision test above already proves results in
      // CONFLICT, not success. This test instead proves the mundane
      // but necessary complement: two owners independently choosing
      // two DIFFERENT ids never interfere with each other.
      const resA = await request(testApp())
        .put('/api/categories/owner-a-independent-id')
        .set(authHeader(OWNER_A))
        .send({ name: 'Owner A Category' });
      const resB = await request(testApp())
        .put('/api/categories/owner-b-independent-id')
        .set(authHeader(OWNER_B))
        .send({ name: 'Owner B Category' });

      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);

      const all = await Category.find({}).lean();
      assert.equal(all.length, 2);
    });
  });
});
