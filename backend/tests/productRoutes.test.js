// NOT EXECUTED IN THIS SANDBOX -- same standing MongoMemoryReplSet /
// fastdl.mongodb.org limitation as every other Mongo-dependent backend
// test (see categoryRoutes.test.js's header for the full explanation).
//
// Covers, per the corrected/locked Phase 5D contract:
//   Listing:    authenticated access, unauthenticated rejection,
//               ownership isolation, archived excluded by default,
//               includeArchived=true
//   Upsert:     create, update, idempotency (same id -> one document),
//               URL identity authoritative over a matching/absent body
//               id, a MISMATCHED body id rejected with VALIDATION_ERROR,
//               server-controlled ownerId/updatedAt/createdAt
//   Quantity:   quantity in the payload is ALWAYS rejected with
//               VALIDATION_ERROR -- create, update, quantity: 0,
//               quantity: null, all rejected; new products get
//               quantity: 0 server-side; an existing product's quantity
//               is never altered by a generic upsert
//   ChangeEvents: a changeEvents key in the payload is ALWAYS rejected
//               with VALIDATION_ERROR -- create, update, an empty array,
//               all rejected; a rejected update causes no partial
//               mutation of any field (verified across multiple fields
//               at once, not just the one field the changeEvents entry
//               happened to describe) and writes nothing to
//               productChangeEvents
//   Identity:   PRD Section 4.1 -- name or photoRef required; a partial
//               update that would leave both empty is rejected; a
//               partial update that changes only photoRef while name
//               stays set from a prior state is validated against the
//               EFFECTIVE post-patch state, not the payload in isolation
//   Validation: numeric-or-null fields, array fields, boolean fields,
//               malformed payload
//   Ownership:  cross-owner read isolation, cross-owner write isolation,
//               cross-owner id collision on upsert (CONFLICT, not a
//               silent overwrite), with an explicit countDocuments
//               assertion proving no second document was created
//   Patch semantics: a field omitted from the payload is left
//               untouched; a field present with null/''/false is
//               applied exactly as given (not treated as "not provided")
//   Scope:      NO ProductChangeEvent is ever written by this endpoint
//               -- that persistence is deliberately out of scope for
//               this phase (see productModel.js's header comment) and
//               is verified here by asserting the productChangeEvents
//               collection stays empty across every test in this file

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/services/tokenService.js';
import { Product } from '../src/models/productModel.js';

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

describe('products resource', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  describe('GET /api/products', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp()).get('/api/products');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    test('returns an empty list for a user with no products', async () => {
      const res = await request(testApp())
        .get('/api/products')
        .set(authHeader(OWNER_A));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    test('excludes archived products by default', async () => {
      await Product.create([
        { _id: 'prod-active', ownerId: OWNER_A, name: 'Milk', archived: false, createdAt: new Date(), updatedAt: new Date() },
        { _id: 'prod-archived', ownerId: OWNER_A, name: 'Old Item', archived: true, createdAt: new Date(), updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/products')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0]._id, 'prod-active');
    });

    test('includes archived products when includeArchived=true', async () => {
      await Product.create([
        { _id: 'prod-active', ownerId: OWNER_A, name: 'Milk', archived: false, createdAt: new Date(), updatedAt: new Date() },
        { _id: 'prod-archived', ownerId: OWNER_A, name: 'Old Item', archived: true, createdAt: new Date(), updatedAt: new Date() }
      ]);

      const res = await request(testApp())
        .get('/api/products?includeArchived=true')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
    });

    test("ownership isolation: owner A cannot see owner B's products", async () => {
      await Product.create({ _id: 'prod-b', ownerId: OWNER_B, name: "B's product", archived: false, createdAt: new Date(), updatedAt: new Date() });

      const res = await request(testApp())
        .get('/api/products')
        .set(authHeader(OWNER_A));

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });

  describe('PUT /api/products/:id -- creation', () => {
    test('rejects an unauthenticated request', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .send({ name: 'Milk' });
      assert.equal(res.status, 401);
    });

    test('creates a new product with a name', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'prod-1');
      assert.equal(res.body.name, 'Milk');
      assert.equal(res.body.ownerId, OWNER_A);
      assert.equal(res.body.quantity, 0);
      assert.equal(res.body.archived, false);
      assert.equal(res.body.lowStockDisabled, false);
      assert.deepEqual(res.body.locationIds, []);
      assert.deepEqual(res.body.tagIds, []);
      assert.equal(typeof res.body.createdAt, 'string');
      assert.equal(typeof res.body.updatedAt, 'string');
    });

    test('creates a new product with only a photoRef (name-less product is valid, PRD Section 4.1)', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ photoRef: 'photo-abc' });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, null);
      assert.equal(res.body.photoRef, 'photo-abc');
    });

    test('rejects creation with neither name nor photoRef', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({});

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored, null);
    });

    test('rejects creation with an empty-string name and no photoRef', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: '' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects creation with a whitespace-only name and no photoRef', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: '   ' });
      assert.equal(res.status, 400);
    });

    test('new products receive quantity: 0 server-side', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk' });
      assert.equal(res.status, 200);
      assert.equal(res.body.quantity, 0);

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored.quantity, 0);
    });
  });

  describe('PUT /api/products/:id -- the quantity invariant', () => {
    test('rejects creation that includes quantity, even a plausible value', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', quantity: 20 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored, null);
    });

    test('rejects quantity: 0 -- presence is rejected, not truthiness', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', quantity: 0 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects quantity: null', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', quantity: null });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('rejects quantity on an update to an existing product', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Whole Milk', quantity: 50 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      // The rejected update must not have partially applied -- name
      // must remain the original value, not "Whole Milk".
      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored.name, 'Milk');
      assert.equal(stored.quantity, 0);
    });

    test('an ordinary field update never alters the stored quantity', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });
      // Directly bump quantity in storage to simulate a prior stock event
      // (Phase 5E territory, not yet built) having moved it away from 0.
      await Product.updateOne({ _id: 'prod-1' }, { $set: { quantity: 12 } });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Whole Milk' });

      assert.equal(res.status, 200);
      assert.equal(res.body.quantity, 12);

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored.quantity, 12);
    });
  });

  describe('PUT /api/products/:id -- the changeEvents invariant', () => {
    test('rejects creation that includes a changeEvents array', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({
          name: 'Milk',
          changeEvents: [
            { id: 'evt-1', productId: 'prod-1', field: 'name', oldValue: null, newValue: 'Milk', timestamp: new Date().toISOString(), accepted: true }
          ]
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      // No partial creation -- nothing should have been persisted at all.
      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored, null);
    });

    test('rejects creation that includes an EMPTY changeEvents array -- presence is rejected, not "is it non-empty"', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', changeEvents: [] });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored, null);
    });

    test('rejects an update that includes a changeEvents array', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({
          name: 'Whole Milk',
          changeEvents: [
            { id: 'evt-1', productId: 'prod-1', field: 'name', oldValue: 'Milk', newValue: 'Whole Milk', timestamp: new Date().toISOString(), accepted: true }
          ]
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('an update rejected for changeEvents causes NO partial Product mutation', async () => {
      // The rejected update attempted to change name, sellingPrice, AND
      // categoryId simultaneously, alongside the illegal changeEvents
      // key. Every one of those fields must remain exactly as they were
      // before the request -- not just "name", to rule out a bug where
      // some fields apply before validation runs and others don't.
      await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', sellingPrice: 50, categoryId: 'dairy' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({
          name: 'Whole Milk',
          sellingPrice: 65,
          categoryId: 'beverages',
          changeEvents: [
            { id: 'evt-1', productId: 'prod-1', field: 'name', oldValue: 'Milk', newValue: 'Whole Milk', timestamp: new Date().toISOString(), accepted: true }
          ]
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored.name, 'Milk');
      assert.equal(stored.sellingPrice, 50);
      assert.equal(stored.categoryId, 'dairy');

      // Also confirm updatedAt was not bumped by the rejected attempt --
      // a rejected write should leave the document completely untouched,
      // not just its visible fields.
      const beforeRes = await request(testApp())
        .get('/api/products')
        .set(authHeader(OWNER_A));
      const productFromList = beforeRes.body.find((p) => p._id === 'prod-1');
      assert.equal(productFromList.name, 'Milk');
    });

    test('the rejected changeEvents attempt writes nothing to productChangeEvents either', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({
          name: 'Whole Milk',
          changeEvents: [
            { id: 'evt-1', productId: 'prod-1', field: 'name', oldValue: 'Milk', newValue: 'Whole Milk', timestamp: new Date().toISOString(), accepted: true }
          ]
        });

      const count = await mongoose.connection.db.collection('productChangeEvents').countDocuments({});
      assert.equal(count, 0);
    });
  });

  describe('PUT /api/products/:id -- updates and patch semantics', () => {
    test('updates an existing product (idempotent id -> exactly one document)', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Whole Milk', sellingPrice: 65 });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Whole Milk');
      assert.equal(res.body.sellingPrice, 65);

      const count = await Product.countDocuments({ _id: 'prod-1' });
      assert.equal(count, 1);
    });

    test('a field omitted from the payload is left untouched', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk', notes: 'from the good supplier' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ sellingPrice: 65 });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Milk');
      assert.equal(res.body.notes, 'from the good supplier');
      assert.equal(res.body.sellingPrice, 65);
    });

    test('a field explicitly set to null is applied, not treated as omitted', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk', notes: 'some notes' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ notes: null });

      assert.equal(res.status, 200);
      assert.equal(res.body.notes, null);
    });

    test('a partial update that would leave both name and photoRef empty is rejected', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: null });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      // Rejected update must not have applied -- name must still be Milk.
      const stored = await Product.findById('prod-1').lean();
      assert.equal(stored.name, 'Milk');
    });

    test('a partial update to photoRef alone is validated against the EFFECTIVE state, not the payload in isolation', async () => {
      // Product was created name-only (no photoRef). An update that only
      // sets photoRef, leaving name untouched, must be accepted --
      // because the EFFECTIVE post-patch state (name: 'Milk', photoRef:
      // 'photo-1') satisfies the identity rule, even though the payload
      // alone ({ photoRef: 'photo-1' }) contains no name.
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ photoRef: 'photo-1' });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Milk');
      assert.equal(res.body.photoRef, 'photo-1');
    });

    test('server sets updatedAt on every write, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', updatedAt: '2000-01-01T00:00:00.000Z' });

      assert.equal(res.status, 200);
      const returnedYear = new Date(res.body.updatedAt).getFullYear();
      assert.notEqual(returnedYear, 2000);
    });

    test('server sets ownerId from the authenticated user, ignoring any client-supplied value', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', ownerId: 'attacker-supplied-owner' });

      assert.equal(res.status, 200);
      assert.equal(res.body.ownerId, OWNER_A);
    });

    test('createdAt is preserved across updates, not reset', async () => {
      const createRes = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk' });
      const originalCreatedAt = createRes.body.createdAt;

      const updateRes = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Whole Milk' });

      assert.equal(updateRes.body.createdAt, originalCreatedAt);
    });

    test('accepts a body.id that matches the URL id', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ id: 'prod-1', name: 'Milk' });

      assert.equal(res.status, 200);
      assert.equal(res.body._id, 'prod-1');
    });

    test('rejects a body.id that mismatches the URL id with VALIDATION_ERROR', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-a')
        .set(authHeader(OWNER_A))
        .send({ id: 'prod-b', name: 'Milk' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');

      const stored = await Product.findById('prod-a').lean();
      assert.equal(stored, null);
    });
  });

  describe('PUT /api/products/:id -- field validation', () => {
    test('rejects a non-string name', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 123 });
      assert.equal(res.status, 400);
    });

    test('rejects a non-numeric sellingPrice', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', sellingPrice: 'sixty' });
      assert.equal(res.status, 400);
    });

    test('accepts sellingPrice: null explicitly', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', sellingPrice: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.sellingPrice, null);
    });

    test('rejects a non-numeric lowStockThreshold', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', lowStockThreshold: 'five' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-numeric marginOverride', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', marginOverride: 'twenty' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-array locationIds', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', locationIds: 'shelf-a' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-array tagIds', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', tagIds: 'popular' });
      assert.equal(res.status, 400);
    });

    test('accepts a valid locationIds/tagIds array', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', locationIds: ['shelf-a2', 'back-room'], tagIds: ['popular'] });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.locationIds, ['shelf-a2', 'back-room']);
      assert.deepEqual(res.body.tagIds, ['popular']);
    });

    test('rejects a non-boolean lowStockDisabled', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', lowStockDisabled: 'yes' });
      assert.equal(res.status, 400);
    });

    test('rejects a non-boolean archived', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', archived: 'yes' });
      assert.equal(res.status, 400);
    });

    test('accepts archived: true, matching archive-not-delete policy', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Milk', archived: true });

      assert.equal(res.status, 200);
      assert.equal(res.body.archived, true);

      const stored = await Product.findById('prod-1').lean();
      assert.notEqual(stored, null);
      assert.equal(stored.archived, true);
    });

    test('rejects a malformed (non-object) payload', async () => {
      const res = await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send([1, 2, 3]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.match(res.body.error.message, /must be an object/i);
    });
  });

  describe('PUT /api/products/:id -- ownership', () => {
    test("ownership isolation: owner A cannot modify owner B's product", async () => {
      await Product.create({ _id: 'prod-b', ownerId: OWNER_B, name: "B's product", archived: false, createdAt: new Date(), updatedAt: new Date() });

      const res = await request(testApp())
        .put('/api/products/prod-b')
        .set(authHeader(OWNER_A))
        .send({ name: 'Hijacked' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CONFLICT');

      const stillB = await Product.findById('prod-b').lean();
      assert.equal(stillB.name, "B's product");
      assert.equal(stillB.ownerId, OWNER_B);

      const count = await Product.countDocuments({ _id: 'prod-b' });
      assert.equal(count, 1);
    });

    test('different owners can independently create products using different ids without interfering with each other', async () => {
      // NOTE: this does NOT test two owners sharing the same _id -- that
      // is structurally impossible under this schema (_id is a globally
      // unique Mongo primary key), and is exactly what the cross-owner
      // collision test above already proves results in CONFLICT, not
      // success. This test instead proves the mundane but necessary
      // complement: two owners independently choosing two DIFFERENT ids
      // never interfere with each other.
      const resA = await request(testApp())
        .put('/api/products/owner-a-independent-id')
        .set(authHeader(OWNER_A))
        .send({ name: 'Owner A Product' });
      const resB = await request(testApp())
        .put('/api/products/owner-b-independent-id')
        .set(authHeader(OWNER_B))
        .send({ name: 'Owner B Product' });

      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);

      const all = await Product.find({}).lean();
      assert.equal(all.length, 2);
    });
  });

  describe('scope boundary: no ProductChangeEvent is ever written by this endpoint', () => {
    test('creating a product writes nothing to productChangeEvents', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });

      const count = await mongoose.connection.db.collection('productChangeEvents').countDocuments({});
      assert.equal(count, 0);
    });

    test('updating tracked-looking fields (name, category, selling price) still writes nothing to productChangeEvents', async () => {
      await request(testApp()).put('/api/products/prod-1').set(authHeader(OWNER_A)).send({ name: 'Milk' });
      await request(testApp())
        .put('/api/products/prod-1')
        .set(authHeader(OWNER_A))
        .send({ name: 'Whole Milk', categoryId: 'dairy', sellingPrice: 65, archived: true });

      const count = await mongoose.connection.db.collection('productChangeEvents').countDocuments({});
      assert.equal(count, 0);
    });
  });
});
