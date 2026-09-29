// NOT EXECUTED IN THE AUTHORING SANDBOX -- needs MongoMemoryReplSet
// (fastdl.mongodb.org is unreachable there). Must be run locally.
//
// Phase 6E-1c concurrency regression: proves a stale JavaScript pre-read
// of the Product can never be written back by the atomic LWW pipeline.
//
// Deterministic orchestration (no sleeps): each "request" gets its own
// service instance whose ProductModel wrapper
//   - returns the SAME stale pre-read snapshot for findOne (both requests
//     "begin from the same old state"), and
//   - holds findOneAndUpdate until an explicit gate opens, so the order
//     in which the two atomic writes COMMIT is dictated by the test.
// Against the previous implementation (`$set: { ...base, ...patch }`),
// the second-committing write restored the stale base before comparing,
// letting an older mutation overwrite a newer one.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createProductService } from '../src/services/productService.js';
import { Product } from '../src/models/productModel.js';

const OWNER = 'owner-a-id';
const ID = 'prod-race';
const T1 = '2026-09-14T10:01:00.000Z';
const T2 = '2026-09-14T10:02:00.000Z';
const T3 = '2026-09-14T10:03:00.000Z';

async function seed() {
  const now = new Date();
  await Product.create({
    _id: ID, ownerId: OWNER, name: 'Race', sellingPrice: 100, quantity: 0,
    createdAt: now, updatedAt: now,
    fieldTimestamps: { sellingPrice: { timestamp: new Date(T1), eventId: 'evt-t1' } }
  });
}

function makeGate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

// Model wrapper: stale pre-read, gated write.
function staleModel(staleSnapshot, gate, onWritten) {
  return {
    find: Product.find.bind(Product),
    findOne: () => ({ lean: async () => structuredClone(staleSnapshot) }),
    findOneAndUpdate: (...args) => {
      const query = (async () => {
        await gate.promise;
        const doc = await Product.findOneAndUpdate(...args).lean();
        onWritten?.();
        return doc;
      })();
      return { lean: () => query };
    }
  };
}

// .lean() returns Map fields as plain objects; tolerate either shape.
const ft = (doc, key) => (doc.fieldTimestamps instanceof Map ? doc.fieldTimestamps.get(key) : doc.fieldTimestamps?.[key]);
const ftCount = (doc) => (doc.fieldTimestamps instanceof Map ? doc.fieldTimestamps.size : Object.keys(doc.fieldTimestamps ?? {}).length);

const price = (value, timestamp, eventId) => ({
  sellingPrice: value,
  fieldMutations: { sellingPrice: { timestamp, eventId } }
});

describe('Phase 6E-1c — stale pre-read cannot roll back LWW state', () => {
  before(connectTestDb);
  beforeEach(async () => { await clearTestDb(); await seed(); });
  after(disconnectTestDb);

  async function race(firstWrites, secondWrites) {
    const stale = await Product.findById(ID).lean();
    const gateFirst = makeGate();
    const gateSecond = makeGate();
    const first = createProductService(staleModel(stale, gateFirst, () => gateSecond.open()));
    const second = createProductService(staleModel(stale, gateSecond));
    // Both requests start (and complete their stale pre-read) before either write commits.
    const p1 = first.upsert(OWNER, ID, firstWrites);
    const p2 = second.upsert(OWNER, ID, secondWrites);
    await new Promise((r) => setImmediate(r));
    gateFirst.open(); // first commits, which then opens the second's gate
    await Promise.all([p1, p2]);
    return Product.findById(ID).lean();
  }

  test('T3 commits first, stale T2 commits second -> T3 survives', async () => {
    const stored = await race(price(300, T3, 'evt-t3'), price(200, T2, 'evt-t2'));
    assert.equal(stored.sellingPrice, 300);
    assert.equal(ft(stored, 'sellingPrice').eventId, 'evt-t3');
    assert.equal(ft(stored, 'sellingPrice').timestamp.toISOString(), T3);
  });

  test('T2 commits first, T3 commits second -> T3 wins', async () => {
    const stored = await race(price(200, T2, 'evt-t2'), price(300, T3, 'evt-t3'));
    assert.equal(stored.sellingPrice, 300);
    assert.equal(ft(stored, 'sellingPrice').eventId, 'evt-t3');
  });

  test('a stale snapshot cannot roll back a field a concurrent request already changed', async () => {
    // First commits a name change (untracked-by-second); second only touches
    // notes from the same stale snapshot and must not restore the old name.
    const stored = await race(
      { name: 'Newer Name', fieldMutations: { name: { timestamp: T3, eventId: 'evt-name' } } },
      { notes: 'a note' }
    );
    assert.equal(stored.name, 'Newer Name');
    assert.equal(stored.notes, 'a note');
    assert.equal(ft(stored, 'name').eventId, 'evt-name');
  });

  test('a concurrent stock-event quantity change between pre-read and write is preserved', async () => {
    const stale = await Product.findById(ID).lean(); // quantity 0
    const gate = makeGate();
    const svc = createProductService(staleModel(stale, gate));
    const p = svc.upsert(OWNER, ID, price(150, T2, 'evt-t2'));
    await new Promise((r) => setImmediate(r));
    await Product.updateOne({ _id: ID }, { $set: { quantity: 7 } }); // stock event lands
    gate.open();
    await p;
    const stored = await Product.findById(ID).lean();
    assert.equal(stored.quantity, 7);
    assert.equal(stored.sellingPrice, 150);
  });

  test('createdAt and untouched fields are preserved from the live document', async () => {
    const before = await Product.findById(ID).lean();
    await createProductService(Product).upsert(OWNER, ID, { notes: 'x' });
    const after = await Product.findById(ID).lean();
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
    assert.equal(after.sellingPrice, 100);
    assert.equal(after.quantity, 0);
  });

  test('genuine insert establishes the COMPLETE default Product shape inside the pipeline', async () => {
    await createProductService(Product).upsert(OWNER, 'prod-new', { name: 'Fresh' });
    const raw = await Product.collection.findOne({ _id: 'prod-new' }); // raw BSON, no Mongoose defaults
    const { createdAt, updatedAt, fieldTimestamps, ...rest } = raw;
    assert.deepEqual(rest, {
      _id: 'prod-new',
      ownerId: OWNER,
      name: 'Fresh',
      photoRef: null,
      quantity: 0,
      unitId: null,
      lowStockThreshold: null,
      lowStockDisabled: false,
      categoryId: null,
      locationIds: [],
      tagIds: [],
      sellingPrice: null,
      marginOverride: null,
      latestPurchaseDate: null,
      notes: null,
      archived: false
    });
    assert.deepEqual(fieldTimestamps, {});
    assert.ok(createdAt instanceof Date && updatedAt instanceof Date);
  });

  test('defaults never overwrite existing values on an existing document', async () => {
    const svc = createProductService(Product);
    await Product.updateOne({ _id: ID }, { $set: {
      photoRef: 'ph', unitId: 'u1', lowStockThreshold: 3, lowStockDisabled: true, categoryId: 'c1',
      locationIds: ['l1'], tagIds: ['t1'], marginOverride: 12, latestPurchaseDate: '2026-09-01', notes: 'n', archived: true, quantity: 4
    } });
    const before = await Product.collection.findOne({ _id: ID });
    await svc.upsert(OWNER, ID, {});
    const after = await Product.collection.findOne({ _id: ID });
    const { updatedAt: _a, ...b } = before;
    const { updatedAt: _b, ...a } = after;
    assert.deepEqual(a, b);
  });

  test('a $-prefixed payload string is stored as text, not evaluated as a field path', async () => {
    await createProductService(Product).upsert(OWNER, ID, { notes: '$name' });
    const stored = await Product.findById(ID).lean();
    assert.equal(stored.notes, '$name');
  });
});
