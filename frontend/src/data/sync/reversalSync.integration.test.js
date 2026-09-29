// Phase 6F — Reversal synchronization contract, frontend half.
//
// Locked contract under test (see docs/PROGRESS.md, Phase 6F):
//   The reversal StockEvent is the synchronized fact. The backend derives
//   and persists original.reversedBy when it accepts that reversal
//   (PUT /api/stock-events/:id, step 8). No independent `reversedBy`
//   mutation is ever queued or sent.
//
// Every module here is the real production module -- real Dexie (fake-
// indexeddb), real repositories/services, real syncQueueLifecycle, real
// createSyncRequest, real syncEntryExecutor, real syncFailureClassifier,
// real syncDrainer. Only apiClient.request() -- the network boundary --
// is replaced by a recorder, exactly the seam syncEntryExecutor depends on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createProductRepository } from '../repositories/productRepository.js';
import { createClassificationRepository } from '../repositories/classificationRepository.js';
import { createStockEventRepository } from '../repositories/stockEventRepository.js';
import { createProductService } from '../../services/productService.js';
import { createStockEventService } from '../../services/stockEventService.js';
import { createSyncQueueLifecycle } from './syncQueueLifecycle.js';
import { createSyncEntryExecutor } from './syncEntryExecutor.js';
import { createSyncDrainer } from './syncDrainer.js';
import { createSyncRequest } from './syncRequest.js';
import { ApiRequestError } from '../../auth/apiClient.js';

describe('Phase 6F — reversal synchronization (frontend half)', () => {
  let db;
  let productRepository;
  let stockEventRepository;
  let productService;
  let stockEventService;
  let syncQueueLifecycle;

  beforeEach(() => {
    db = createDatabase();
    productRepository = createProductRepository(db);
    stockEventRepository = createStockEventRepository(db);
    productService = createProductService(productRepository, createClassificationRepository(db));
    stockEventService = createStockEventService(stockEventRepository, productRepository);
    syncQueueLifecycle = createSyncQueueLifecycle(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // ADD 10, REMOVE 4 (the event that will be reversed), then reverse it.
  async function buildOriginalThenReversal() {
    const { product } = await productService.createProduct({ name: 'Milk' });
    const { event: add } = await stockEventService.addStock({ productId: product.id, quantity: 10 });
    const { event: original } = await stockEventService.removeStock({ productId: product.id, quantity: 4 });
    const { event: reversal, errors } = await stockEventService.reverseEvent(original.id);
    expect(errors).toEqual([]);
    return { product, add, original, reversal };
  }

  const stockEventRows = async () =>
    (await db.syncQueue.orderBy('localId').toArray()).filter((r) => r.entityType === 'stockEvent');

  function makeDrainer(respond) {
    const requests = [];
    const apiClient = {
      request: async (req) => {
        requests.push(req);
        return respond(req);
      },
    };
    const drainer = createSyncDrainer({
      syncQueueLifecycle,
      syncEntryExecutor: createSyncEntryExecutor({ apiClient }),
    });
    return { drainer, requests };
  }

  it('queues the original StockEvent strictly before its reversal (localId FIFO)', async () => {
    const { original, reversal } = await buildOriginalThenReversal();
    const rows = await stockEventRows();
    const ids = rows.map((r) => r.entityId);
    expect(ids.indexOf(original.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(reversal.id)).toBeGreaterThan(ids.indexOf(original.id));
    const [origRow, revRow] = [rows.find((r) => r.entityId === original.id), rows.find((r) => r.entityId === reversal.id)];
    expect(revRow.localId).toBeGreaterThan(origRow.localId);
  });

  it('the reversal wire request preserves id, reversalOf, productId, type, quantity, recordedAt, expectedCurrentQuantity and omits appliedQuantity', async () => {
    const { product, original, reversal } = await buildOriginalThenReversal();
    const revRow = (await stockEventRows()).find((r) => r.entityId === reversal.id);

    const { method, path, body } = createSyncRequest(revRow);

    expect(method).toBe('PUT');
    expect(path).toBe(`/api/stock-events/${reversal.id}`);
    expect(body.id).toBe(reversal.id);
    expect(body.reversalOf).toBe(original.id);
    expect(body.productId).toBe(product.id);
    expect(body.type).toBe('ADD'); // opposite of the original REMOVE
    expect(body.quantity).toBe(4); // original's appliedQuantity
    expect(body.recordedAt).toBe(reversal.recordedAt);
    expect(body.expectedCurrentQuantity).toBe(6); // quantity when the reversal was committed
    expect(Object.hasOwn(body, 'appliedQuantity')).toBe(false); // server-computed, rejected by presence
    // The queued row itself still carries appliedQuantity locally (wire != queue).
    expect(revRow.payload.appliedQuantity).toBe(4);
  });

  it('reversedBy is never transported: no queued entry carries a non-null reversedBy, and no reversedBy-specific entry exists', async () => {
    const { original, reversal } = await buildOriginalThenReversal();

    // Local state IS patched (local read model)...
    expect((await stockEventRepository.getById(original.id)).reversedBy).toBe(reversal.id);

    // ...but the relationship is not a synchronized mutation of its own.
    const rows = await db.syncQueue.toArray();
    expect(new Set(rows.map((r) => r.entityType))).toEqual(new Set(['product', 'stockEvent']));
    for (const row of rows.filter((r) => r.entityType === 'stockEvent')) {
      expect(row.payload.reversedBy ?? null).toBeNull();
      expect(createSyncRequest(row).body.reversedBy ?? null).toBeNull();
    }
    // Exactly one stockEvent entry per StockEvent (ADD, REMOVE, reversal) -- nothing extra for the patch.
    expect((await stockEventRows()).length).toBe(3);
  });

  it('reversing an ADD produces a REMOVE wire body the backend can accept: no costPerUnit/purchaseDate keys, reversalOf preserved', async () => {
    const { product } = await productService.createProduct({ name: 'Milk' });
    const { event: add } = await stockEventService.addStock({ productId: product.id, quantity: 10 });
    const { event: reversal, errors } = await stockEventService.reverseEvent(add.id);
    expect(errors).toEqual([]);

    const row = (await stockEventRows()).find((r) => r.entityId === reversal.id);
    const { body } = createSyncRequest(row);
    expect(body.type).toBe('REMOVE');
    expect(body.reversalOf).toBe(add.id);
    expect(body.quantity).toBe(10);
    expect(body.expectedCurrentQuantity).toBe(10);
    expect(Object.hasOwn(body, 'costPerUnit')).toBe(false);
    expect(Object.hasOwn(body, 'purchaseDate')).toBe(false);
  });

  it('drains stockEvent requests to the API in FIFO order: original before reversal', async () => {
    const { add, original, reversal } = await buildOriginalThenReversal();
    const queued = await db.syncQueue.count();
    const { drainer, requests } = makeDrainer(() => ({ ok: true }));

    const result = await drainer.drain();

    expect(result).toEqual({ processed: queued, failed: 0, stopped: false, reason: null });
    const stockPaths = requests.filter((r) => r.path.startsWith('/api/stock-events/')).map((r) => r.path);
    expect(stockPaths).toEqual([
      `/api/stock-events/${add.id}`,
      `/api/stock-events/${original.id}`,
      `/api/stock-events/${reversal.id}`,
    ]);
    expect(await db.syncQueue.count()).toBe(0);
  });

  it('a retried reversal (dropped response) is re-sent byte-identically, reusing the ORIGINAL expectedCurrentQuantity', async () => {
    const { reversal } = await buildOriginalThenReversal();
    let reversalAttempts = 0;
    const { drainer, requests } = makeDrainer((req) => {
      if (req.path.endsWith(reversal.id)) {
        reversalAttempts += 1;
        if (reversalAttempts === 1) {
          // Response lost after the server committed: surfaces as a transient failure.
          throw new ApiRequestError('INTERNAL_ERROR', 'timeout', 503);
        }
      }
      return { ok: true };
    });

    const first = await drainer.drain();
    expect(first.stopped).toBe(true);
    const second = await drainer.drain(); // recovery returns the 'processing' entry to pending, then retries
    expect(second.stopped).toBe(false);

    const sent = requests.filter((r) => r.path.endsWith(reversal.id));
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body); // same expectedCurrentQuantity, same id
    expect(await db.syncQueue.count()).toBe(0);
  });

  it('if the original was permanently rejected, the reversal is rejected permanently too (404), never retried, and the drain continues', async () => {
    const { original, reversal } = await buildOriginalThenReversal();
    const { drainer, requests } = makeDrainer((req) => {
      if (req.path.endsWith(original.id)) {
        throw new ApiRequestError('QUANTITY_CONSISTENCY_CONFLICT', 'stale', 409);
      }
      if (req.path.endsWith(reversal.id)) {
        throw new ApiRequestError('NOT_FOUND', 'The event being reversed was not found.', 404);
      }
      return { ok: true };
    });

    const result = await drainer.drain();

    expect(result.stopped).toBe(false);
    expect(result.failed).toBe(2);
    expect(requests.filter((r) => r.path.endsWith(reversal.id))).toHaveLength(1); // no invented retry policy
    const failedReversal = await db.syncQueue.filter((r) => r.entityId === reversal.id).first();
    expect(failedReversal.status).toBe('failed');
    expect(failedReversal.lastError).toContain('NOT_FOUND');
    // A later drain does not re-send permanently failed entries.
    requests.length = 0;
    await drainer.drain();
    expect(requests.filter((r) => r.path.endsWith(reversal.id))).toHaveLength(0);
  });
});
