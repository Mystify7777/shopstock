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
import { createProductChangeEventService } from '../src/services/productChangeEventService.js';

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
        oldValue: 'a', newValue: 'b', timestamp: new Date()
      });

      const res = await request(testApp()).get('/api/product-change-events').set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('filters by productId when provided', async () => {
      await seedProduct('prod-1', OWNER_A);
      await seedProduct('prod-2', OWNER_A);
      await ProductChangeEvent.create([
        { _id: 'evt-1', ownerId: OWNER_A, productId: 'prod-1', field: 'name', oldValue: 'a', newValue: 'b', timestamp: new Date() },
        { _id: 'evt-2', ownerId: OWNER_A, productId: 'prod-2', field: 'name', oldValue: 'a', newValue: 'b', timestamp: new Date() }
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
      // Product has no fieldTimestamps entry for this field -> not accepted.
      assert.equal(res.body.accepted, false);
      assert.equal(res.body.ownerId, OWNER_A);

      const stored = await ProductChangeEvent.findById('evt-1').lean();
      assert.ok(stored);
      assert.equal(Object.hasOwn(stored, 'accepted'), false);
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

  describe('Phase 6E-1d — accepted is computed at read time from Product.fieldTimestamps', () => {
    const TS = '2026-09-02T14:30:00.000Z';
    const body = (over = {}) => ({
      productId: 'prod-1', field: 'sellingPrice', oldValue: 60, newValue: 65, timestamp: TS, ...over
    });
    const put = (id, payload, owner = OWNER_A) =>
      request(testApp()).put(`/api/product-change-events/${id}`).set(authHeader(owner)).send(payload);
    const setStamp = (field, timestamp, eventId, productId = 'prod-1') =>
      Product.updateOne({ _id: productId }, { $set: { [`fieldTimestamps.${field}`]: { timestamp: new Date(timestamp), eventId } } });
    const listFor = async (productId = 'prod-1') =>
      (await request(testApp()).get('/api/product-change-events').query({ productId }).set(authHeader(OWNER_A))).body;

    test('event matching the Product field timestamp AND eventId -> accepted: true (PUT response and list)', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', TS, 'evt-1');
      const res = await put('evt-1', body());
      assert.equal(res.body.accepted, true);
      assert.equal((await listFor())[0].accepted, true);
    });

    test('older event superseded by a newer Product mutation -> accepted: false', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', '2026-09-02T14:35:00.000Z', 'evt-newer');
      const res = await put('evt-old', body());
      assert.equal(res.body.accepted, false);
      assert.equal((await listFor())[0].accepted, false);
    });

    test('same timestamp but different eventId -> accepted: false', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', TS, 'some-other-event');
      const res = await put('evt-1', body());
      assert.equal(res.body.accepted, false);
    });

    test('field with no current Product timestamp -> accepted: false', async () => {
      await seedProduct('prod-1', OWNER_A);
      const res = await put('evt-1', body({ field: 'name', oldValue: 'a', newValue: 'b' }));
      assert.equal(res.body.accepted, false);
    });

    test('acceptance is evaluated per field, independently', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', TS, 'evt-price');
      await setStamp('name', '2026-09-02T15:00:00.000Z', 'evt-name-newer');
      await put('evt-price', body());
      await put('evt-name', body({ field: 'name', oldValue: 'a', newValue: 'b' }));
      const byId = Object.fromEntries((await listFor()).map((e) => [e._id, e.accepted]));
      assert.deepEqual(byId, { 'evt-price': true, 'evt-name': false });
    });

    test('category/location/tags events use the event-field key in fieldTimestamps', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('category', TS, 'evt-cat');
      const res = await put('evt-cat', body({ field: 'category', oldValue: null, newValue: 'c1' }));
      assert.equal(res.body.accepted, true);
    });

    test('the stored Mongo event has no authoritative accepted field', async () => {
      await seedProduct('prod-1', OWNER_A);
      await put('evt-1', body());
      const raw = await ProductChangeEvent.collection.findOne({ _id: 'evt-1' });
      assert.equal(Object.hasOwn(raw, 'accepted'), false);
    });

    test('a stale stored accepted on a legacy document cannot control the response', async () => {
      await seedProduct('prod-1', OWNER_A);
      await ProductChangeEvent.collection.insertOne({
        _id: 'evt-legacy', ownerId: OWNER_A, productId: 'prod-1', field: 'name',
        oldValue: 'a', newValue: 'b', timestamp: new Date(TS), accepted: true
      });
      const item = (await listFor()).find((e) => e._id === 'evt-legacy');
      assert.equal(item.accepted, false); // no Product timestamp -> not accepted
      const retry = await put('evt-legacy', body({ field: 'name', oldValue: 'a', newValue: 'b' }));
      assert.equal(retry.body.accepted, false);
    });

    test('client-supplied accepted (true or false) is rejected and never influences the result', async () => {
      await seedProduct('prod-1', OWNER_A);
      for (const accepted of [true, false]) {
        const res = await put(`evt-${accepted}`, body({ accepted }));
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      }
      assert.equal(await ProductChangeEvent.countDocuments({}), 0);
    });

    test('persisting an event does not mutate the Product (including fieldTimestamps)', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', '2026-09-02T14:35:00.000Z', 'evt-x');
      const before = await Product.collection.findOne({ _id: 'prod-1' });
      await put('evt-1', body());
      const after = await Product.collection.findOne({ _id: 'prod-1' });
      assert.deepEqual(after, before);
    });

    test('idempotent retry returns the same event, no second write; accepted reflects current Product state', async () => {
      await seedProduct('prod-1', OWNER_A);
      const first = await put('evt-1', body());
      assert.equal(first.body.accepted, false);
      await setStamp('sellingPrice', TS, 'evt-1'); // Product LWW now records this event as the winner
      const retry = await put('evt-1', body());
      assert.equal(retry.status, 200);
      assert.equal(retry.body.accepted, true);
      assert.equal(await ProductChangeEvent.countDocuments({}), 1);
    });

    test('retry after the Product is gone still succeeds as a no-op (accepted: false)', async () => {
      await seedProduct('prod-1', OWNER_A);
      await put('evt-1', body());
      await Product.deleteOne({ _id: 'prod-1' });
      const retry = await put('evt-1', body());
      assert.equal(retry.status, 200);
      assert.equal(retry.body.accepted, false);
    });

    test('ownership: another owner cannot see or influence acceptance; NOT_FOUND / CONFLICT unchanged', async () => {
      await seedProduct('prod-1', OWNER_A);
      await setStamp('sellingPrice', TS, 'evt-1');
      await put('evt-1', body());
      const otherList = await request(testApp()).get('/api/product-change-events').set(authHeader(OWNER_B));
      assert.deepEqual(otherList.body, []);
      const notFound = await put('evt-b', body(), OWNER_B);
      assert.equal(notFound.status, 404);
      const collision = await put('evt-1', body({ productId: 'prod-b' }), OWNER_B);
      assert.ok([404, 409].includes(collision.status));
    });

    test('PUT response accepted uses a fresh Product read: a Product LWW write landing between the validation read and the insert is reflected', async () => {
      await seedProduct('prod-1', OWNER_A);
      // Deterministic interleaving: the Product's LWW state is updated
      // right after the event insert commits, i.e. after the earlier
      // validation read but before the response is computed.
      const racingEventModel = {
        find: ProductChangeEvent.find.bind(ProductChangeEvent),
        findOne: ProductChangeEvent.findOne.bind(ProductChangeEvent),
        create: async (doc) => {
          const created = await ProductChangeEvent.create(doc);
          await setStamp('sellingPrice', TS, 'evt-1');
          return created;
        }
      };
      const svc = createProductChangeEventService(racingEventModel, Product);
      const result = await svc.processEvent(OWNER_A, 'evt-1', body());
      assert.equal(result.accepted, true);
    });

    test('arrival order: event persisted BEFORE the Product upsert, accepted flips true once the Product LWW lands', async () => {
      await seedProduct('prod-1', OWNER_A);
      const ev = await put('evt-1', body());
      assert.equal(ev.body.accepted, false);
      const up = await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A))
        .send({ sellingPrice: 65, fieldMutations: { sellingPrice: { timestamp: TS, eventId: 'evt-1' } } });
      assert.equal(up.status, 200);
      assert.equal((await listFor())[0].accepted, true);
    });

    test('arrival order: Product upsert BEFORE the event -> accepted: true on first persist', async () => {
      await seedProduct('prod-1', OWNER_A);
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A))
        .send({ sellingPrice: 65, fieldMutations: { sellingPrice: { timestamp: TS, eventId: 'evt-1' } } });
      const ev = await put('evt-1', body());
      assert.equal(ev.body.accepted, true);
    });
  });
});
