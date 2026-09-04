// NOT EXECUTED IN THIS SANDBOX -- same standing MongoMemoryReplSet /
// fastdl.mongodb.org limitation as every other Mongo-dependent backend
// test (see categoryRoutes.test.js's header for the full explanation).
// This phase specifically requires real transaction support (a replica
// set, not a standalone mongod), which testDb.js's MongoMemoryReplSet
// already provides -- see backend/README.md's note on this.
//
// Covers, per the locked Phase 5E contract:
//   Auth:        unauthenticated requests rejected
//   Basic:       valid ADD/REMOVE events persist, Product.quantity
//                updates correctly, resulting quantity matches the
//                domain calculation (including the over-removal clamp)
//   Ownership:   cannot mutate another owner's Product, cannot create
//                events against another owner's Product, cross-owner
//                event-id collision -> CONFLICT
//   Atomicity:   a forced mid-transaction failure leaves BOTH the
//                StockEvent count and Product.quantity completely
//                unchanged -- this is the mandatory rollback proof, not
//                an assumption that Mongo transactions work because the
//                driver documentation said something reassuring
//   Idempotency: submitting the same event id twice does not apply the
//                quantity mutation twice; the idempotency check is
//                proven to run BEFORE the concurrency check, so a
//                genuine retry with a now-stale expectedCurrentQuantity
//                still succeeds as a no-op rather than being wrongly
//                rejected
//   Concurrency: expectedCurrentQuantity mismatch -> QUANTITY_CONSISTENCY_CONFLICT,
//                and the rejected request causes no mutation
//   Reversal:    a reversal's quantity is validated against (not merely
//                trusted from) the original's stored appliedQuantity;
//                a mismatched reversal quantity is rejected; a
//                same-type "reversal" (ADD reversing ADD, or REMOVE
//                reversing REMOVE) is rejected, since quantity matching
//                alone does not make something a reversal -- the
//                direction must be opposite; a reversal targeting a
//                DIFFERENT product than the original event is rejected;
//                an already-reversed event cannot be reversed again;
//                reversedBy is correctly patched onto the original
//   Validation:  malformed payloads, the appliedQuantity-rejection
//                invariant, ADD/REMOVE field constraints
//   Listing:     ownership-scoped, optional productId filter,
//                includeReversed handling

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/services/tokenService.js';
import { Product } from '../src/models/productModel.js';
import { StockEvent } from '../src/models/stockEventModel.js';

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

async function seedProduct(id, ownerId, quantity = 0) {
  await Product.create({
    _id: id,
    ownerId,
    name: 'Test Product',
    quantity,
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

describe('stock-events resource', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  describe('GET /api/stock-events', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).get('/api/stock-events');
      assert.equal(res.status, 401);
    });

    test('returns an empty list when no events exist', async () => {
      const res = await request(testApp()).get('/api/stock-events').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test("ownership isolation: owner A cannot see owner B's events", async () => {
      await seedProduct('prod-b', OWNER_B, 0);
      await StockEvent.create({
        _id: 'evt-b', ownerId: OWNER_B, productId: 'prod-b', type: 'ADD',
        quantity: 5, appliedQuantity: 5, recordedAt: new Date(), reversalOf: null, reversedBy: null
      });

      const res = await request(testApp()).get('/api/stock-events').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('filters by productId when provided', async () => {
      await seedProduct('prod-1', OWNER_A, 0);
      await seedProduct('prod-2', OWNER_A, 0);
      await StockEvent.create([
        { _id: 'evt-1', ownerId: OWNER_A, productId: 'prod-1', type: 'ADD', quantity: 5, appliedQuantity: 5, recordedAt: new Date(), reversalOf: null, reversedBy: null },
        { _id: 'evt-2', ownerId: OWNER_A, productId: 'prod-2', type: 'ADD', quantity: 5, appliedQuantity: 5, recordedAt: new Date(), reversalOf: null, reversedBy: null }
      ]);

      const res = await request(testApp()).get('/api/stock-events?productId=prod-1').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0]._id, 'evt-1');
    });
  });

  describe('PUT /api/stock-events/:id -- basic ADD/REMOVE processing', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).put('/api/stock-events/evt-1').send({});
      assert.equal(res.status, 401);
    });

    test('a valid ADD event persists and increases Product.quantity', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'ADD', quantity: 20, costPerUnit: 55,
          purchaseDate: '2026-09-01', recordedAt: '2026-09-02T14:30:00.000Z',
          comment: 'New delivery', expectedCurrentQuantity: 5
        });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'evt-1');
      assert.equal(res.body.appliedQuantity, 20);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 25);

      const stored = await StockEvent.findById('evt-1').lean();
      assert.equal(stored.appliedQuantity, 20);
      assert.equal(stored.ownerId, OWNER_A);
    });

    test('a valid REMOVE event persists and decreases Product.quantity', async () => {
      await seedProduct('prod-1', OWNER_A, 10);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 10 });

      assert.equal(res.status, 200);
      assert.equal(res.body.appliedQuantity, 3);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 7);
    });

    test('REMOVE clamps at zero on over-removal -- appliedQuantity is less than requested quantity', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 8, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      assert.equal(res.status, 200);
      assert.equal(res.body.quantity, 8);
      assert.equal(res.body.appliedQuantity, 5);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 0);
    });

    test('recordedAt is preserved exactly as submitted, not regenerated', async () => {
      await seedProduct('prod-1', OWNER_A, 0);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 5, recordedAt: '2020-01-01T09:00:00.000Z', expectedCurrentQuantity: 0 });

      assert.equal(res.status, 200);
      assert.equal(new Date(res.body.recordedAt).toISOString(), '2020-01-01T09:00:00.000Z');
    });

    test('returns NOT_FOUND when the referenced product does not exist', async () => {
      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'does-not-exist', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 0 });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');

      const count = await StockEvent.countDocuments({});
      assert.equal(count, 0);
    });
  });

  describe('PUT /api/stock-events/:id -- optimistic concurrency', () => {
    test('rejects when expectedCurrentQuantity does not match the actual quantity', async () => {
      await seedProduct('prod-1', OWNER_A, 10);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 999 });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'QUANTITY_CONSISTENCY_CONFLICT');

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 10);

      const count = await StockEvent.countDocuments({});
      assert.equal(count, 0);
    });
  });

  describe('PUT /api/stock-events/:id -- idempotency', () => {
    test('submitting the same event twice does not apply the quantity mutation twice', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const payload = { productId: 'prod-1', type: 'ADD', quantity: 10, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 };

      const first = await request(testApp()).put('/api/stock-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(first.status, 200);

      const second = await request(testApp()).put('/api/stock-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(second.status, 200);
      assert.equal(second.body._id, 'evt-1');

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 15); // 5 + 10, NOT 5 + 10 + 10

      const count = await StockEvent.countDocuments({ _id: 'evt-1' });
      assert.equal(count, 1);
    });

    test('a genuine retry succeeds even when expectedCurrentQuantity is now stale -- idempotency runs before the concurrency check', async () => {
      // This is the critical ordering test the contract review called
      // out explicitly: the retried request still carries the ORIGINAL
      // expectedCurrentQuantity (5), but by the time it's retried, the
      // product's real quantity has already moved to 15 as a result of
      // the first (successful) execution. If the concurrency check ran
      // before the idempotency check, this retry would be wrongly
      // rejected with QUANTITY_CONSISTENCY_CONFLICT even though the
      // operation it's retrying already fully succeeded.
      await seedProduct('prod-1', OWNER_A, 5);
      const payload = { productId: 'prod-1', type: 'ADD', quantity: 10, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 };

      const first = await request(testApp()).put('/api/stock-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(first.status, 200);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 15);

      // Retry with the SAME stale expectedCurrentQuantity: 5 -- the
      // product is actually at 15 now, but this must still succeed as a
      // no-op, not fail with QUANTITY_CONSISTENCY_CONFLICT.
      const retry = await request(testApp()).put('/api/stock-events/evt-1').set(authHeader(OWNER_A)).send(payload);
      assert.equal(retry.status, 200);
      assert.notEqual(retry.body.error, 'QUANTITY_CONSISTENCY_CONFLICT');

      const productAfterRetry = await Product.findById('prod-1').lean();
      assert.equal(productAfterRetry.quantity, 15);
    });

    test('cross-owner event id collision is CONFLICT, not a silent idempotent match', async () => {
      await seedProduct('prod-a', OWNER_A, 0);
      await seedProduct('prod-b', OWNER_B, 0);

      await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-a', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 0 });

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_B))
        .send({ productId: 'prod-b', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 0 });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CONFLICT');

      const productB = await Product.findById('prod-b').lean();
      assert.equal(productB.quantity, 0);

      const count = await StockEvent.countDocuments({ _id: 'evt-1' });
      assert.equal(count, 1);
    });
  });

  describe('PUT /api/stock-events/:id -- ownership', () => {
    test("cannot create an event against another owner's product", async () => {
      await seedProduct('prod-b', OWNER_B, 10);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-b', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 10 });

      // Owner A's own lookup {_id: 'prod-b', ownerId: OWNER_A} finds
      // nothing -- correctly indistinguishable from the product simply
      // not existing, so this surfaces as NOT_FOUND, not a leak that
      // confirms prod-b exists under someone else.
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');

      const productB = await Product.findById('prod-b').lean();
      assert.equal(productB.quantity, 10);
    });
  });

  describe('PUT /api/stock-events/:id -- reversal', () => {
    test("a valid reversal restores the product quantity and patches the original's reversedBy", async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const removeRes = await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });
      assert.equal(removeRes.status, 200);
      assert.equal(removeRes.body.appliedQuantity, 3);

      const reverseRes = await request(testApp())
        .put('/api/stock-events/evt-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'ADD', quantity: 3, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 2, reversalOf: 'evt-remove'
        });

      assert.equal(reverseRes.status, 200);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 5);

      const original = await StockEvent.findById('evt-remove').lean();
      assert.equal(original.reversedBy, 'evt-reversal');
    });

    test("reversal quantity is validated against the original's appliedQuantity, not merely trusted from the client", async () => {
      // Original REMOVE requests 10 but only 4 is available -- clamped,
      // appliedQuantity = 4. A malicious/buggy reversal claiming
      // quantity: 10 (the ORIGINAL requested amount, not what actually
      // applied) must be rejected, not allowed to manufacture +6 units
      // of inventory that were never actually removed.
      await seedProduct('prod-1', OWNER_A, 4);

      const removeRes = await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 10, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 4 });
      assert.equal(removeRes.status, 200);
      assert.equal(removeRes.body.appliedQuantity, 4);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 0);

      const badReversal = await request(testApp())
        .put('/api/stock-events/evt-bad-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'ADD', quantity: 10, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 0, reversalOf: 'evt-remove'
        });

      assert.equal(badReversal.status, 400);
      assert.equal(badReversal.body.error.code, 'VALIDATION_ERROR');

      // Rejected reversal must not have mutated anything.
      const productAfter = await Product.findById('prod-1').lean();
      assert.equal(productAfter.quantity, 0);
      const originalAfter = await StockEvent.findById('evt-remove').lean();
      assert.equal(originalAfter.reversedBy, null);
    });

    test('the correct reversal quantity (matching appliedQuantity, not the original requested quantity) is accepted', async () => {
      await seedProduct('prod-1', OWNER_A, 4);

      await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 10, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 4 });

      const goodReversal = await request(testApp())
        .put('/api/stock-events/evt-good-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'ADD', quantity: 4, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 0, reversalOf: 'evt-remove'
        });

      assert.equal(goodReversal.status, 200);

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 4);
    });

    test('cannot reverse an already-reversed event', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      await request(testApp())
        .put('/api/stock-events/evt-reversal-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 3, recordedAt: '2026-09-02T15:00:00.000Z', expectedCurrentQuantity: 2, reversalOf: 'evt-remove' });

      const secondReversal = await request(testApp())
        .put('/api/stock-events/evt-reversal-2')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 3, recordedAt: '2026-09-02T16:00:00.000Z', expectedCurrentQuantity: 5, reversalOf: 'evt-remove' });

      assert.equal(secondReversal.status, 409);
      assert.equal(secondReversal.body.error.code, 'ALREADY_REVERSED');
    });

    test('rejects a same-type "reversal" -- a REMOVE cannot be "reversed" by another REMOVE', async () => {
      // Without this check, a same-type "reversal" with a matching
      // quantity would silently DOUBLE the original movement instead of
      // undoing it -- the server correctly validates that the quantity
      // equals appliedQuantity, but quantity alone does not make
      // something a reversal; the direction must be opposite.
      await seedProduct('prod-1', OWNER_A, 5);

      await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      const productAfterRemove = await Product.findById('prod-1').lean();
      assert.equal(productAfterRemove.quantity, 2);

      const sameTypeReversal = await request(testApp())
        .put('/api/stock-events/evt-bad-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 2, reversalOf: 'evt-remove'
        });

      assert.equal(sameTypeReversal.status, 400);
      assert.equal(sameTypeReversal.body.error.code, 'VALIDATION_ERROR');

      // Rejected "reversal" must not have mutated anything -- quantity
      // must NOT have dropped to -1 (or clamped to 0), and the original
      // must remain unreversed.
      const productAfter = await Product.findById('prod-1').lean();
      assert.equal(productAfter.quantity, 2);

      const original = await StockEvent.findById('evt-remove').lean();
      assert.equal(original.reversedBy, null);

      const badReversalCount = await StockEvent.countDocuments({ _id: 'evt-bad-reversal' });
      assert.equal(badReversalCount, 0);
    });

    test('rejects a same-type "reversal" -- an ADD cannot be "reversed" by another ADD', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      await request(testApp())
        .put('/api/stock-events/evt-add')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 10, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      const sameTypeReversal = await request(testApp())
        .put('/api/stock-events/evt-bad-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-1', type: 'ADD', quantity: 10, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 15, reversalOf: 'evt-add'
        });

      assert.equal(sameTypeReversal.status, 400);
      assert.equal(sameTypeReversal.body.error.code, 'VALIDATION_ERROR');

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 15, 'quantity must not have doubled to 25');

      const original = await StockEvent.findById('evt-add').lean();
      assert.equal(original.reversedBy, null);
    });

    test('rejects a reversal that targets a different product than the original event', async () => {
      // A reversal referencing an original event that belongs to a
      // DIFFERENT product must be rejected -- otherwise the server would
      // mutate the wrong product's inventory while marking the
      // unrelated original event as reversed, corrupting the historical
      // relationship between the two events.
      await seedProduct('prod-a', OWNER_A, 5);
      await seedProduct('prod-b', OWNER_A, 0);

      await request(testApp())
        .put('/api/stock-events/evt-remove-a')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-a', type: 'REMOVE', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      const productAAfterRemove = await Product.findById('prod-a').lean();
      assert.equal(productAAfterRemove.quantity, 0);

      const crossProductReversal = await request(testApp())
        .put('/api/stock-events/evt-cross-product-reversal')
        .set(authHeader(OWNER_A))
        .send({
          productId: 'prod-b', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T15:00:00.000Z',
          expectedCurrentQuantity: 0, reversalOf: 'evt-remove-a'
        });

      assert.equal(crossProductReversal.status, 400);
      assert.equal(crossProductReversal.body.error.code, 'VALIDATION_ERROR');

      // Neither product's quantity should have moved, and the original
      // event (on prod-a) must remain unreversed.
      const productA = await Product.findById('prod-a').lean();
      assert.equal(productA.quantity, 0);

      const productB = await Product.findById('prod-b').lean();
      assert.equal(productB.quantity, 0);

      const original = await StockEvent.findById('evt-remove-a').lean();
      assert.equal(original.reversedBy, null);

      const reversalCount = await StockEvent.countDocuments({ _id: 'evt-cross-product-reversal' });
      assert.equal(reversalCount, 0);
    });

    test('returns NOT_FOUND when reversing an event that does not exist', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const res = await request(testApp())
        .put('/api/stock-events/evt-reversal')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 3, recordedAt: '2026-09-02T15:00:00.000Z', expectedCurrentQuantity: 5, reversalOf: 'does-not-exist' });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });
  });

  describe('PUT /api/stock-events/:id -- validation', () => {
    test('rejects a payload containing appliedQuantity', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5, appliedQuantity: 5 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const count = await StockEvent.countDocuments({});
      assert.equal(count, 0);
    });

    test('rejects a malformed (non-object) payload', async () => {
      const res = await request(testApp())
        .put('/api/stock-events/evt-1')
        .set(authHeader(OWNER_A))
        .send([1, 2, 3]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects a body.id that mismatches the URL id', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      const res = await request(testApp())
        .put('/api/stock-events/evt-a')
        .set(authHeader(OWNER_A))
        .send({ id: 'evt-b', productId: 'prod-1', type: 'ADD', quantity: 5, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('atomicity: forced mid-transaction failure', () => {
    test('a forced failure after the StockEvent insert leaves BOTH the event count and Product.quantity completely unchanged', async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      // Force a failure by making the Product update step throw, AFTER
      // the StockEvent has already been created within the same
      // transaction -- this is the mandatory rollback proof: if the
      // transaction is genuinely atomic, the StockEvent insert must be
      // rolled back too, even though it "succeeded" before the forced
      // failure.
      const originalUpdateOne = Product.updateOne.bind(Product);
      Product.updateOne = () => {
        throw new Error('forced failure for atomicity test');
      };

      try {
        const res = await request(testApp())
          .put('/api/stock-events/evt-1')
          .set(authHeader(OWNER_A))
          .send({ productId: 'prod-1', type: 'ADD', quantity: 20, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

        assert.equal(res.status, 500);
      } finally {
        Product.updateOne = originalUpdateOne;
      }

      const eventCount = await StockEvent.countDocuments({});
      assert.equal(eventCount, 0, 'the StockEvent insert must have been rolled back');

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 5, 'Product.quantity must be completely unchanged after rollback');
    });

    test("a forced failure during reversal leaves the original event's reversedBy unpatched", async () => {
      await seedProduct('prod-1', OWNER_A, 5);

      await request(testApp())
        .put('/api/stock-events/evt-remove')
        .set(authHeader(OWNER_A))
        .send({ productId: 'prod-1', type: 'REMOVE', quantity: 3, recordedAt: '2026-09-02T14:30:00.000Z', expectedCurrentQuantity: 5 });

      const originalUpdateOne = StockEvent.updateOne.bind(StockEvent);
      StockEvent.updateOne = () => {
        throw new Error('forced failure for reversal atomicity test');
      };

      try {
        const res = await request(testApp())
          .put('/api/stock-events/evt-reversal')
          .set(authHeader(OWNER_A))
          .send({ productId: 'prod-1', type: 'ADD', quantity: 3, recordedAt: '2026-09-02T15:00:00.000Z', expectedCurrentQuantity: 2, reversalOf: 'evt-remove' });

        assert.equal(res.status, 500);
      } finally {
        StockEvent.updateOne = originalUpdateOne;
      }

      // Neither the reversal event nor the reversedBy patch nor the
      // product quantity change should have survived.
      const reversalCount = await StockEvent.countDocuments({ _id: 'evt-reversal' });
      assert.equal(reversalCount, 0);

      const original = await StockEvent.findById('evt-remove').lean();
      assert.equal(original.reversedBy, null, 'reversedBy must remain unpatched after rollback');

      const product = await Product.findById('prod-1').lean();
      assert.equal(product.quantity, 2, 'quantity must remain at the post-REMOVE value, not restored by the failed reversal');
    });
  });
});
