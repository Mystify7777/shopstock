// NOT EXECUTED IN THIS SANDBOX -- same standing MongoMemoryReplSet /
// fastdl.mongodb.org limitation as every other Mongo-dependent backend
// test (see categoryRoutes.test.js's header for the full explanation).
//
// Covers, per the locked Phase 5F contract:
//   Auth:        unauthenticated requests rejected
//   Basic:       a valid event persists with the exact submitted field/
//                oldValue/newValue/timestamp, and accepted forced to
//                true server-side regardless of what (if anything) the
//                client might have tried to send
//   Idempotency: submitting the same event id twice returns the
//                existing event without a second write, and -- the
//                critical ordering case -- a retry succeeds even when
//                the referenced Product no longer exists, because
//                idempotency is checked BEFORE the Product lookup
//   Ownership:   cannot create an event against another owner's
//                product; cross-owner event-id collision -> CONFLICT;
//                cannot see another owner's events when listing
//   Referential: NOT_FOUND when the referenced product does not exist
//   integrity:   at all, and NOT_FOUND when it exists but belongs to a
//                different owner (these must be indistinguishable, same
//                as every prior ownership boundary in this project)
//   Validation:  the accepted-rejection invariant (rejected even when
//                the client submits accepted: true), presence-based
//                oldValue/newValue requirements (an explicit null must
//                be accepted, an entirely absent key must not), the
//                field enum, malformed payloads, URL/body id mismatch
//   Boundary:    this endpoint never mutates the Product it references
//                -- verified explicitly, not just asserted in a comment
//   Listing:     ownership-scoped, optional productId filter

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/services/tokenService.js';
import { Product } from '../src/models/productModel.js';
import { ProductChangeEvent } from '../src/models/productChangeEventModel.js';

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

async function seedProduct(id, ownerId) {
  await Product.create({
    _id: id,
    ownerId,
    name: 'Test Product',
    quantity: 0,
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

describe('product-change-events resource', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  describe('GET /api/product-change-events', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).get('/api/product-change-events');
      assert.equal(res.status, 401);
    });

    test('returns an empty list when no events exist', async () => {
      const res = await request(testApp()).get('/api/product-change-events').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test("ownership isolation: owner A cannot see owner B's events", async () => {
      await seedProduct('prod-b', OWNER_B);
      await ProductChangeEvent.create({
        _id: 'evt-b', ownerId: OWNER_B, productId: 'prod-b', field: 'name',
        oldValue: 'a', newValue: 'b', timestamp: new Date(), accepted: true
      });

      const res = await request(testApp()).get('/api/product-change-events').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('filters by productId when provided', async () => {
      await seedProduct('prod-1', OWNER_A);
      await seedProduct('prod-2', OWNER_A);
      await ProductChangeEvent.create([
        { _id: 'evt-1', ownerId: OWNER_A, productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: new Date(), accepted: true },
        { _id: 'evt-2', ownerId: OWNER_A, productId: 'prod-2', field: 'name', oldValue: 'a', newValue: 'b', timestamp: new Date(), accepted: true }
      ]);

      const res = await request(testApp()).get('/api/product-change-events?productId=prod-1').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0]._id, 'evt-1');
    });
  });

  describe('PUT /api/product-change-events/:id -- basic persistence', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).put('/api/product-change-events/evt-1').send({});
      assert.equal(res.status, 401);
    });

    test('a valid event persists with the exact submitted fields', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', field: 'sellingPrice', oldValue: 60, newValue: 65,
          timestamp: '2026-09-02T14:30:00.000Z'
        });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'evt-1');
      assert.equal(res.body.productId, 'prod-1');
      assert.equal(res.body.field, 'sellingPrice');
      assert.equal(res.body.oldValue, 60);
      assert.equal(res.body.newValue, 65);
      assert.equal(new Date(res.body.timestamp).toISOString(), '2026-09-02T14:30:00.000Z');
      assert.equal(res.body.accepted, true);
      assert.equal(res.body.ownerId, OWNER_A);

      const stored = await ProductChangeEvent.findById('evt-1').lean();
      assert.ok(stored);
      assert.equal(stored.accepted, true);
    });

    test('accepted is always true server-side, even though the client can never submit it', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'Milk', newValue: 'Whole Milk', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 200);
      assert.equal(res.body.accepted, true);
    });

    test('an explicit null oldValue is accepted and preserved (e.g. a category first being set)', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'category', oldValue: null, newValue: 'dairy', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 200);
      assert.equal(res.body.oldValue, null);
    });

    test('timestamp is preserved exactly as submitted, not regenerated', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2020-01-01T09:00:00.000Z' });

      assert.equal(res.status, 200);
      assert.equal(new Date(res.body.timestamp).toISOString(), '2020-01-01T09:00:00.000Z');
    });
  });

  describe('PUT /api/product-change-events/:id -- referential integrity', () => {
    test('returns NOT_FOUND when the referenced product does not exist at all', async () => {
      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'does-not-exist', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');

      const count = await ProductChangeEvent.countDocuments({});
      assert.equal(count, 0);
    });

    test("returns NOT_FOUND when the referenced product exists but belongs to a different owner (indistinguishable from not existing at all)", async () => {
      await seedProduct('prod-b', OWNER_B);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-b', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');

      const count = await ProductChangeEvent.countDocuments({});
      assert.equal(count, 0);

      // The referenced product itself must be completely untouched --
      // this endpoint has no business mutating it under any
      // circumstance, including a rejected request.
      const productB = await Product.findById('prod-b').lean();
      assert.equal(productB.name, 'Test Product');
    });
  });

  describe('PUT /api/product-change-events/:id -- idempotency', () => {
    test('submitting the same event twice returns the existing event, no second write', async () => {
      await seedProduct('prod-1', OWNER_A);
      const payload = { productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' };

      const first = await request(testApp()).put('/api/product-change-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(first.status, 200);

      const second = await request(testApp()).put('/api/product-change-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(second.status, 200);
      assert.equal(second.body._id, 'evt-1');

      const count = await ProductChangeEvent.countDocuments({ _id: 'evt-1' });
      assert.equal(count, 1);
    });

    test('a retry succeeds as a no-op even when the referenced product no longer exists -- idempotency runs before the Product lookup', async () => {
      // This is the ordering the locked contract specifically requires:
      // the event already exists from a first successful call, so a
      // retry must return it WITHOUT re-checking the Product -- even if
      // the product has since been deleted/archived/whatever. A retry
      // of an already-succeeded historical write should never fail due
      // to unrelated later state.
      await seedProduct('prod-1', OWNER_A);
      const payload = { productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' };

      const first = await request(testApp()).put('/api/product-change-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(first.status, 200);

      // Remove the product entirely -- if the retry re-checked Product
      // existence before idempotency, this would now fail with
      // NOT_FOUND even though the event already exists.
      await Product.deleteOne({ _id: 'prod-1' });

      const retry = await request(testApp()).put('/api/product-change-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(retry.status, 200);
      assert.equal(retry.body._id, 'evt-1');
    });

    test('cross-owner event id collision is CONFLICT, not a silent idempotent match', async () => {
      await seedProduct('prod-a', OWNER_A);
      await seedProduct('prod-b', OWNER_B);

      await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-a', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_B))
        .send({ productId: 'prod-b', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CONFLICT');

      const count = await ProductChangeEvent.countDocuments({ _id: 'evt-1' });
      assert.equal(count, 1);
    });
  });

  describe('PUT /api/product-change-events/:id -- validation', () => {
    test('rejects a payload containing accepted: true', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z', accepted: true });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const count = await ProductChangeEvent.countDocuments({});
      assert.equal(count, 0);
    });

    test('rejects a payload containing accepted: false', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z', accepted: false });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a payload with oldValue entirely absent (as distinct from explicit null)', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a payload with newValue entirely absent', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'a', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects an invalid field value outside the tracked enum', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'quantity', oldValue: 1, newValue: 2, timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a malformed (non-object) payload', async () => {
      const res = await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send([1, 2, 3]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a body.id that mismatches the URL id', async () => {
      await seedProduct('prod-1', OWNER_A);

      const res = await request(testApp())
        .put('/api/product-change-events/evt-a')
        .set(authHeader(OWNER_A))
        .send({ id: 'evt-b', productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: '2026-09-02T14:30:00.000Z' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('scope boundary: this endpoint never mutates the Product it references', () => {
    test('persisting a change event does not alter any field on the referenced Product', async () => {
      await seedProduct('prod-1', OWNER_A);
      const before = await Product.findById('prod-1').lean();

      await request(testApp())
        .put('/api/product-change-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', field: 'name', oldValue: 'Test Product', newValue: 'Renamed Product', timestamp: '2026-09-02T14:30:00.000Z' });

      const after = await Product.findById('prod-1').lean();
      assert.equal(after.name, before.name, 'the Product.name field itself must be unchanged -- only the historical event record is written');
      assert.deepEqual(after.updatedAt, before.updatedAt, 'Product.updatedAt must not be bumped by an unrelated change-event write');
    });
  });
});
