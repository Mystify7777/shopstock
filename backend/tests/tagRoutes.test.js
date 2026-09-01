// NOT EXECUTED IN THIS SANDBOX -- same standing MongoMemoryReplSet /
// fastdl.mongodb.org limitation as every other Mongo-dependent backend
// test (see categoryRoutes.test.js's header for the full explanation).
//
// Mirrors the Phase 5C classification contract covered exhaustively in
// categoryRoutes.test.js, using the Tag model and the public
// /api/tags resource. See that file for the full rationale
// behind each case, including the cross-owner upsert collision handling.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/services/tokenService.js';
import { Tag } from '../src/models/classificationModel.js';

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

describe('tags resource', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  describe('GET /api/tags', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).get('/api/tags');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('returns an empty list for a user with no tags', async () => {
      const res = await request(testApp())
        .get('/api/tags')
        .set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('excludes archived tags by default', async () => {
      await Tag.create([
        { _id: 'tag-active', ownerId: OWNER_A, name: 'Test Name', archived: false, isDefault: false, updatedAt: new Date() },
        { _id: 'tag-archived', ownerId: OWNER_A, name: 'Old', archived: true, isDefault: false, updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/tags')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0]._id, 'tag-active');
    });

    test('includes archived tags when includeArchived=true', async () => {
      await Tag.create([
        { _id: 'tag-active', ownerId: OWNER_A, name: 'Test Name', archived: false, isDefault: false, updatedAt: new Date() },
        { _id: 'tag-archived', ownerId: OWNER_A, name: 'Old', archived: true, isDefault: false, updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/tags?includeArchived=true')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
    });

    test('ownership isolation: owner A cannot see owner B\'s tags', async () => {
      await Tag.create({ _id: 'tag-b', ownerId: OWNER_B, name: 'B\'s tag', archived: false, isDefault: false, updatedAt: new Date() });

      const res = await request(testApp())
        .get('/api/tags')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });

  describe('PUT /api/tags/:id', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .send({ name: 'Test Name' });
      assert.equal(res.status, 401);
    });

    test('creates a new tag', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Test Name' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'tag-1');
      assert.equal(res.body.name, 'Test Name');
      assert.equal(res.body.ownerId, OWNER_A);
      assert.equal(res.body.archived, false);
      assert.equal(res.body.isDefault, false);
      assert.equal(typeof res.body.updatedAt, 'string');

      const stored = await Tag.findById('tag-1').lean();
      assert.ok(stored);
      assert.equal(stored.ownerId, OWNER_A);
    });

    test('updates an existing tag (idempotent id -> exactly one document)', async () => {
      await request(testApp()).put('/api/tags/tag-1').set(authHeader(OWNER_A)).send({ name: 'Test Name' });
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Snacks & Beverages', archived: true });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Snacks & Beverages');
      assert.equal(res.body.archived, true);

      const count = await Tag.countDocuments({ _id: 'tag-1' });
      assert.equal(count, 1);
    });

    test('server sets updatedAt on every write, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Test Name', updatedAt: '2000-01-01T00:00:00.000Z' });

      assert.equal(res.status, 200);
      const returnedYear = new Date(res.body.updatedAt).getFullYear();
      assert.notEqual(returnedYear, 2000);
    });

    test('server sets ownerId from the authenticated user, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Test Name', ownerId: 'attacker-supplied-owner' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ownerId, OWNER_A);
    });

    test('accepts a body.id that matches the URL id', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ id: 'tag-1', name: 'Test Name' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'tag-1');
    });

    test('rejects a body.id that mismatches the URL id with VALIDATION_ERROR', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-a')
        .set(authHeader(OWNER_A))
        .send({ id: 'tag-b', name: 'Electronics' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Tag.findById('tag-a').lean();
      assert.equal(stored, null);
    });

    test('rejects an empty name', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: '' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a whitespace-only name', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: '   ' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('trims a valid name with surrounding whitespace', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: '  Snacks  ' });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Snacks');
    });

    test('rejects a non-string name', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 123 });
      assert.equal(res.status, 400);
    });

    test('rejects a non-boolean archived value', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Test Name', archived: 'yes' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-boolean isDefault value', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Test Name', isDefault: 'yes' });
      assert.equal(res.status, 400);
    });

    test('rejects a malformed (non-object) payload', async () => {
      const res = await request(testApp())
        .put('/api/tags/tag-1')
        .set(authHeader(OWNER_A))
        .send([1, 2, 3]);
      assert.equal(res.status, 400);
    });

    test('ownership isolation: owner A cannot modify owner B\'s tag', async () => {
      await Tag.create({ _id: 'tag-b', ownerId: OWNER_B, name: 'B\'s tag', archived: false, isDefault: false, updatedAt: new Date() });

      const res = await request(testApp())
        .put('/api/tags/tag-b')
        .set(authHeader(OWNER_A))
        .send({ name: 'Hijacked' });

      // The (_id, ownerId) filter matches nothing for owner A, so this
      // is treated as an insert attempt against an _id that already
      // exists -- a duplicate-key collision -> CONFLICT, never a
      // silent overwrite of B's document.
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CONFLICT');

      const stillB = await Tag.findById('tag-b').lean();
      assert.equal(stillB.name, 'B\'s tag');
      assert.equal(stillB.ownerId, OWNER_B);

      // Explicitly document the invariant, not just infer it: the
      // collision attempt must not have created a second document
      // under any circumstance (_id is a globally unique Mongo primary
      // key, so this is guaranteed in practice, but the test should
      // say so rather than leave it implicit).
      const count = await Tag.countDocuments({ _id: 'tag-b' });
      assert.equal(count, 1);
    });

    test('different owners can independently create tags using different ids without interfering with each other', async () => {
      // NOTE: this does NOT test two owners sharing the same _id --
      // that is structurally impossible under this schema (_id is a
      // globally unique Mongo primary key), and is exactly what the
      // cross-owner collision test above already proves results in
      // CONFLICT, not success. This test instead proves the mundane
      // but necessary complement: two owners independently choosing
      // two DIFFERENT ids never interfere with each other.
      const resA = await request(testApp())
        .put('/api/tags/owner-a-independent-id')
        .set(authHeader(OWNER_A))
        .send({ name: 'Owner A Tag' });
      const resB = await request(testApp())
        .put('/api/tags/owner-b-independent-id')
        .set(authHeader(OWNER_B))
        .send({ name: 'Owner B Tag' });

      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);

      const all = await Tag.find({}).lean();
      assert.equal(all.length, 2);
    });
  });
});
