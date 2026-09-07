import { describe, it, expect } from 'vitest';
import { createSyncRequest, UnknownSyncEntityTypeError } from './syncRequest.js';

// ---------------------------------------------------------------------------
// Helpers — build minimal, realistic queue entries. Field values beyond
// what each test actually exercises are filled with plausible placeholders,
// matching the shape the real buildXSyncEntry() functions in the
// repositories actually produce (verified against source before writing
// this file, not assumed).
// ---------------------------------------------------------------------------

function makeQueueEntry(overrides = {}) {
  return {
    localId: 1,
    entityType: 'category',
    operation: 'upsert',
    entityId: 'ent-1',
    clientId: 'client-1',
    payload: { id: 'ent-1', name: 'Snacks', archived: false, isDefault: false },
    attempts: 0,
    status: 'pending',
    createdAt: '2026-09-06T10:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

describe('createSyncRequest', () => {
  // -------------------------------------------------------------------------
  // Routing — one case per recognized entityType
  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('routes category to PUT /api/categories/:entityId', () => {
      const entry = makeQueueEntry({ entityType: 'category', entityId: 'cat-1' });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/categories/cat-1');
    });

    it('routes location to PUT /api/locations/:entityId', () => {
      const entry = makeQueueEntry({ entityType: 'location', entityId: 'loc-1' });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/locations/loc-1');
    });

    it('routes tag to PUT /api/tags/:entityId', () => {
      const entry = makeQueueEntry({ entityType: 'tag', entityId: 'tag-1' });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/tags/tag-1');
    });

    it('routes unit to PUT /api/units/:entityId', () => {
      const entry = makeQueueEntry({ entityType: 'unit', entityId: 'unit-1' });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/units/unit-1');
    });

    it('routes product to PUT /api/products/:entityId', () => {
      const entry = makeQueueEntry({
        entityType: 'product',
        entityId: 'prod-1',
        payload: { id: 'prod-1', name: 'Parle-G', quantity: 5 },
      });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/products/prod-1');
    });

    it('routes stockEvent to PUT /api/stock-events/:entityId', () => {
      const entry = makeQueueEntry({
        entityType: 'stockEvent',
        entityId: 'evt-1',
        payload: {
          id: 'evt-1',
          productId: 'prod-1',
          type: 'ADD',
          quantity: 10,
          recordedAt: '2026-09-06T10:00:00.000Z',
          expectedCurrentQuantity: 5,
          appliedQuantity: 10,
        },
      });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/stock-events/evt-1');
    });

    it('routes productChangeEvent to PUT /api/product-change-events/:entityId', () => {
      const entry = makeQueueEntry({
        entityType: 'productChangeEvent',
        entityId: 'change-1',
        payload: {
          id: 'change-1',
          productId: 'prod-1',
          field: 'name',
          oldValue: 'a',
          newValue: 'b',
          timestamp: '2026-09-06T10:00:00.000Z',
          accepted: true,
        },
      });
      const { method, path } = createSyncRequest(entry);
      expect(method).toBe('PUT');
      expect(path).toBe('/api/product-change-events/change-1');
    });

    it('uses entityId, not clientId, in the path', () => {
      const entry = makeQueueEntry({
        entityType: 'category',
        entityId: 'cat-1',
        clientId: 'totally-different-client-id',
      });
      const { path } = createSyncRequest(entry);
      expect(path).toBe('/api/categories/cat-1');
    });
  });

  // -------------------------------------------------------------------------
  // Classification pass-through — no stripping needed
  // -------------------------------------------------------------------------

  describe('classification body (no stripping)', () => {
    it('passes the payload through unchanged for category', () => {
      const payload = { id: 'cat-1', name: 'Snacks', archived: false, isDefault: true };
      const entry = makeQueueEntry({ entityType: 'category', entityId: 'cat-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body).toEqual(payload);
    });

    it('returns a new object, not the same reference as payload', () => {
      const payload = { id: 'cat-1', name: 'Snacks', archived: false, isDefault: true };
      const entry = makeQueueEntry({ entityType: 'category', entityId: 'cat-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body).not.toBe(payload);
    });
  });

  // -------------------------------------------------------------------------
  // Product — quantity must be stripped
  // -------------------------------------------------------------------------

  describe('product body', () => {
    function makeProductPayload(overrides = {}) {
      return {
        id: 'prod-1',
        name: 'Parle-G',
        photoRef: null,
        quantity: 42,
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
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-06T10:00:00.000Z',
        archived: false,
        ...overrides,
      };
    }

    it('omits quantity from the wire body', () => {
      const payload = makeProductPayload({ quantity: 42 });
      const entry = makeQueueEntry({ entityType: 'product', entityId: 'prod-1', payload });
      const { body } = createSyncRequest(entry);
      expect(Object.hasOwn(body, 'quantity')).toBe(false);
    });

    it('preserves every other product field unchanged', () => {
      const payload = makeProductPayload({ name: 'Good Day', sellingPrice: 25 });
      const entry = makeQueueEntry({ entityType: 'product', entityId: 'prod-1', payload });
      const { body } = createSyncRequest(entry);
      const { quantity, ...expectedRest } = payload;
      expect(body).toEqual(expectedRest);
    });

    it('strips quantity even when it is 0', () => {
      const payload = makeProductPayload({ quantity: 0 });
      const entry = makeQueueEntry({ entityType: 'product', entityId: 'prod-1', payload });
      const { body } = createSyncRequest(entry);
      expect(Object.hasOwn(body, 'quantity')).toBe(false);
    });

    it('does not mutate the original payload object', () => {
      const payload = makeProductPayload({ quantity: 42 });
      const entry = makeQueueEntry({ entityType: 'product', entityId: 'prod-1', payload });
      createSyncRequest(entry);
      expect(Object.hasOwn(payload, 'quantity')).toBe(true);
      expect(payload.quantity).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // StockEvent — appliedQuantity stripped, expectedCurrentQuantity preserved
  // -------------------------------------------------------------------------

  describe('stockEvent body', () => {
    function makeStockEventPayload(overrides = {}) {
      return {
        id: 'evt-1',
        productId: 'prod-1',
        type: 'REMOVE',
        quantity: 8,
        costPerUnit: null,
        purchaseDate: null,
        recordedAt: '2026-09-06T10:00:00.000Z',
        comment: null,
        reversalOf: null,
        expectedCurrentQuantity: 5,
        appliedQuantity: 5,
        ...overrides,
      };
    }

    it('omits appliedQuantity from the wire body', () => {
      const payload = makeStockEventPayload();
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      const { body } = createSyncRequest(entry);
      expect(Object.hasOwn(body, 'appliedQuantity')).toBe(false);
    });

    it('preserves expectedCurrentQuantity exactly as queued, not recomputed', () => {
      const payload = makeStockEventPayload({ expectedCurrentQuantity: 5 });
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body.expectedCurrentQuantity).toBe(5);
    });

    it('preserves every other stockEvent field unchanged', () => {
      const payload = makeStockEventPayload({ comment: 'Sold to customer' });
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      const { body } = createSyncRequest(entry);
      const { appliedQuantity, ...expectedRest } = payload;
      expect(body).toEqual(expectedRest);
    });

    it('does not mutate the original payload object', () => {
      const payload = makeStockEventPayload({ appliedQuantity: 5 });
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      createSyncRequest(entry);
      expect(Object.hasOwn(payload, 'appliedQuantity')).toBe(true);
      expect(payload.appliedQuantity).toBe(5);
      expect(payload.expectedCurrentQuantity).toBe(5);
    });

    it('a retry reusing the exact same queue entry produces an identical body', () => {
      // Simulates the Phase 6A contract's retry requirement: the same
      // queue entry, translated twice, must yield the same wire request
      // -- nothing here recomputes from "current" state.
      const payload = makeStockEventPayload({ expectedCurrentQuantity: 5, appliedQuantity: 5 });
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      const first = createSyncRequest(entry);
      const second = createSyncRequest(entry);
      expect(first).toEqual(second);
    });

    it('strips appliedQuantity even when it is 0', () => {
      const payload = makeStockEventPayload({ appliedQuantity: 0, expectedCurrentQuantity: 0 });
      const entry = makeQueueEntry({ entityType: 'stockEvent', entityId: 'evt-1', payload });
      const { body } = createSyncRequest(entry);
      expect(Object.hasOwn(body, 'appliedQuantity')).toBe(false);
      expect(body.expectedCurrentQuantity).toBe(0);
    });

    it('preserves entityId as event.id for both entityId and the path (StockEvent identity rule)', () => {
      const payload = makeStockEventPayload({ id: 'evt-99' });
      const entry = makeQueueEntry({
        entityType: 'stockEvent',
        entityId: 'evt-99',
        clientId: 'evt-99',
        payload,
      });
      const { path, body } = createSyncRequest(entry);
      expect(path).toBe('/api/stock-events/evt-99');
      expect(body.id).toBe('evt-99');
    });
  });

  // -------------------------------------------------------------------------
  // ProductChangeEvent — accepted stripped, history fields preserved
  // -------------------------------------------------------------------------

  describe('productChangeEvent body', () => {
    function makeChangeEventPayload(overrides = {}) {
      return {
        id: 'change-1',
        productId: 'prod-1',
        field: 'sellingPrice',
        oldValue: 20,
        newValue: 25,
        timestamp: '2026-09-06T10:00:00.000Z',
        accepted: true,
        ...overrides,
      };
    }

    it('omits accepted from the wire body', () => {
      const payload = makeChangeEventPayload();
      const entry = makeQueueEntry({ entityType: 'productChangeEvent', entityId: 'change-1', payload });
      const { body } = createSyncRequest(entry);
      expect(Object.hasOwn(body, 'accepted')).toBe(false);
    });

    it('preserves oldValue/newValue/timestamp/field/productId unchanged', () => {
      const payload = makeChangeEventPayload();
      const entry = makeQueueEntry({ entityType: 'productChangeEvent', entityId: 'change-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body.oldValue).toBe(20);
      expect(body.newValue).toBe(25);
      expect(body.timestamp).toBe('2026-09-06T10:00:00.000Z');
      expect(body.field).toBe('sellingPrice');
      expect(body.productId).toBe('prod-1');
    });

    it('preserves falsy/null/zero oldValue and newValue exactly (not coerced away)', () => {
      const payload = makeChangeEventPayload({ field: 'archived', oldValue: false, newValue: true });
      const entry = makeQueueEntry({ entityType: 'productChangeEvent', entityId: 'change-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body.oldValue).toBe(false);
      expect(body.newValue).toBe(true);
    });

    it('preserves an explicit null oldValue (e.g. a category cleared to Uncategorized)', () => {
      const payload = makeChangeEventPayload({ field: 'category', oldValue: 'cat-1', newValue: null });
      const entry = makeQueueEntry({ entityType: 'productChangeEvent', entityId: 'change-1', payload });
      const { body } = createSyncRequest(entry);
      expect(body.newValue).toBeNull();
    });

    it('does not mutate the original payload object', () => {
      const payload = makeChangeEventPayload();
      const entry = makeQueueEntry({ entityType: 'productChangeEvent', entityId: 'change-1', payload });
      createSyncRequest(entry);
      expect(Object.hasOwn(payload, 'accepted')).toBe(true);
      expect(payload.accepted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No mutation of the queue entry itself, across all entity types
  // -------------------------------------------------------------------------

  describe('no mutation of the queue entry', () => {
    it('leaves the entire entry object unchanged after translation', () => {
      const entry = makeQueueEntry({
        entityType: 'stockEvent',
        entityId: 'evt-1',
        payload: {
          id: 'evt-1',
          productId: 'prod-1',
          type: 'ADD',
          quantity: 10,
          recordedAt: '2026-09-06T10:00:00.000Z',
          expectedCurrentQuantity: 3,
          appliedQuantity: 10,
        },
      });
      const snapshot = JSON.parse(JSON.stringify(entry));
      createSyncRequest(entry);
      expect(entry).toEqual(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown entityType
  // -------------------------------------------------------------------------

  describe('unknown entityType', () => {
    it('throws UnknownSyncEntityTypeError rather than producing a malformed request', () => {
      const entry = makeQueueEntry({ entityType: 'somethingMadeUp' });
      expect(() => createSyncRequest(entry)).toThrow(UnknownSyncEntityTypeError);
    });

    it('throws for a missing entityType', () => {
      const entry = makeQueueEntry({ entityType: undefined });
      expect(() => createSyncRequest(entry)).toThrow(UnknownSyncEntityTypeError);
    });
  });
});
