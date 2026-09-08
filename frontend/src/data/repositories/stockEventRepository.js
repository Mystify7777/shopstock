// Stock event repository.
//
// Persistence boundary for StockEvent records and the product quantity
// mutations they drive. This is the most structurally complex repository
// in the codebase because one logical stock operation requires three tables
// to stay consistent, and a reversal requires four writes across those same
// three tables — all in one atomic Dexie transaction.
//
// This file owns:
//   - reading stock events from IndexedDB (by id, by productId)
//   - committing a new stock event atomically with its product quantity
//     update and both corresponding sync queue entries
//   - committing a reversal atomically with its product quantity update,
//     the reversedBy patch on the original event, and sync queue entries
//
// This file does NOT own:
//   - calling applyStockEvent() — the service calls that and passes the
//     results (nextQuantity, appliedQuantity, expectedCurrentQuantity) in
//   - calling createReversalEvent() — the service owns reversal construction
//   - calculating cost, margin, or low-stock status
//   - validating business fields (quantity > 0, appliedQuantity range, etc.)
//     — those invariants are enforced by the domain layer
//   - sync queue processing, retries, or network (sync engine, Phase 6)
//
// Remote convergence of the reversedBy pointer: this file creates NO
// separate sync queue entry for the local reversedBy patch (step 6 in
// commitReversal() below) — this was originally flagged as an open
// Phase 6 decision, but Phase 6B0's cross-boundary verification (see
// docs/PROGRESS.md) confirmed this is CORRECT, not a gap. The reversal
// StockEvent queue entry already carries reversalOf; the backend's
// PUT /api/stock-events/:id transaction derives and persists the
// original event's reversedBy from that field atomically, in the same
// transaction as the reversal event's own insert, with no separate
// request or queue entry required.
//
// See docs/ARCHITECTURE.md:
//   "Stock-event commit atomicity"
//   "appliedQuantity must travel across every persistence boundary"
//   "entityId vs. clientId"

import { generateId } from '../../domain/shared/ids.js';
import { timestampNow } from '../../domain/shared/dates.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class InvalidStockEventError extends Error {
  constructor(reason) {
    super(`Invalid stock event: ${reason}`);
    this.name = 'InvalidStockEventError';
  }
}

export class InvalidProductError extends Error {
  constructor(reason) {
    super(`Invalid product: ${reason}`);
    this.name = 'InvalidProductError';
  }
}

export class ProductNotFoundError extends Error {
  constructor(id) {
    super(`Product not found: ${id}`);
    this.name = 'ProductNotFoundError';
  }
}

export class StockEventNotFoundError extends Error {
  constructor(id) {
    super(`Stock event not found: ${id}`);
    this.name = 'StockEventNotFoundError';
  }
}

export class QuantityConsistencyError extends Error {
  constructor(expected, actual) {
    super(
      `Quantity consistency check failed. ` +
        `Expected current quantity ${expected}, found ${actual}. ` +
        `The product was modified between the service read and this commit.`
    );
    this.name = 'QuantityConsistencyError';
  }
}

export class AlreadyReversedError extends Error {
  constructor(eventId) {
    super(`Stock event ${eventId} has already been reversed.`);
    this.name = 'AlreadyReversedError';
  }
}

export class ReversalReferenceError extends Error {
  constructor(reversalOf, originalEventId) {
    super(
      `Reversal reference mismatch: reversalEvent.reversalOf is "${reversalOf}" ` +
        `but originalEventId is "${originalEventId}".`
    );
    this.name = 'ReversalReferenceError';
  }
}

// ---------------------------------------------------------------------------
// Sync queue entry builders
// ---------------------------------------------------------------------------

/**
 * Build the syncQueue insert entry for a committed stock event.
 *
 * entityId = event.id   (stable document identity)
 * clientId = event.id   (safe: insert-only, one event = one immutable record)
 *
 * The queued payload carries both appliedQuantity AND
 * expectedCurrentQuantity -- two storage-layer fields the domain
 * StockEvent shape itself does not have:
 *
 *   appliedQuantity          the true applied delta (see the header
 *                            comment's AMENDMENT) -- MANDATORY in the
 *                            payload: without it, a device that receives
 *                            this event via sync cannot correctly
 *                            reverse a clamped over-removal, on this
 *                            device or any device that receives this
 *                            event via sync.
 *
 *   expectedCurrentQuantity  the Product.quantity value this operation
 *                            was committed against -- the exact value
 *                            observed at commit time (see commit()'s own
 *                            parameter of the same name), captured here
 *                            once and never recomputed. The Phase 5
 *                            backend's PUT /api/stock-events/:id
 *                            endpoint requires this field on every
 *                            request; a retry must resend the SAME
 *                            queued value, not a freshly-read current
 *                            quantity -- re-reading at retry time would
 *                            silently change what the request is
 *                            asserting and defeat the backend's own
 *                            idempotency-before-consistency-check
 *                            ordering (see docs/ARCHITECTURE.md,
 *                            StockEvent transaction ordering).
 *
 * createSyncRequest() (frontend/src/data/sync/syncRequest.js) is what
 * strips appliedQuantity back off before the value ever reaches the
 * wire -- that stripping is a transport concern, not a queue-production
 * concern, which is why both fields are deliberately kept here.
 */
function buildStockEventSyncEntry(event, appliedQuantity, expectedCurrentQuantity) {
  return {
    entityType: 'stockEvent',
    operation: 'insert',
    entityId: event.id,
    clientId: event.id,
    payload: { ...event, appliedQuantity, expectedCurrentQuantity },
    attempts: 0,
    status: 'pending',
    createdAt: timestampNow(),
    lastError: null,
  };
}

/**
 * Build the syncQueue upsert entry for a product state mutation.
 *
 * entityId = product.id  (stable document identity)
 * clientId = generateId() (fresh per mutation — the same product can be
 *   mutated by multiple stock events; each must have a distinct clientId
 *   so server idempotency does not treat later mutations as retries of
 *   earlier ones)
 *
 * See docs/ARCHITECTURE.md "entityId vs. clientId".
 */
function buildProductSyncEntry(product, nextQuantity) {
  return {
    entityType: 'product',
    operation: 'upsert',
    entityId: product.id,
    clientId: generateId(),
    payload: { ...product, quantity: nextQuantity },
    attempts: 0,
    status: 'pending',
    createdAt: timestampNow(),
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a stock event repository backed by the given Dexie database.
 *
 * @param {import('dexie').Dexie} db
 */
export function createStockEventRepository(db) {

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  /**
   * Return a single stored stock event row by primary key, or undefined.
   *
   * Returns the full Dexie row — domain event fields PLUS the persisted
   * appliedQuantity column. The service needs appliedQuantity when loading
   * an event to build a reversal (PRD §15 historical reversal path).
   *
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async function getById(id) {
    return db.stockEvents.get(id);
  }

  // -------------------------------------------------------------------------
  // getByProductId
  // -------------------------------------------------------------------------

  /**
   * Return all stored stock event rows for a product, ordered by recordedAt
   * ascending (oldest first — the natural history display order).
   *
   * @param {string} productId
   * @returns {Promise<object[]>}
   */
  async function getByProductId(productId) {
    return db.stockEvents
      .where('productId')
      .equals(productId)
      .sortBy('recordedAt');
  }

  // -------------------------------------------------------------------------
  // commit
  // -------------------------------------------------------------------------

  /**
   * Atomically commit a new stock event, update the product's materialized
   * quantity, and enqueue both sync entries.
   *
   * The service is responsible for having called applyStockEvent() to
   * produce nextQuantity, appliedQuantity, and for passing the product
   * quantity it read (expectedCurrentQuantity) so this repository can
   * verify the product has not changed since that read.
   *
   * Transaction tables: db.stockEvents, db.products, db.syncQueue
   *
   * All writes succeed or all roll back — no partial state.
   *
   * @param {object} params
   * @param {object}  params.event                 Domain stock event (from factory)
   * @param {number}  params.appliedQuantity        True applied delta (from applyStockEvent)
   * @param {number}  params.nextQuantity           New product quantity (from applyStockEvent)
   * @param {number}  params.expectedCurrentQuantity Product quantity at service read time
   * @param {object}  params.product               Current product object
   * @returns {Promise<object>} The persisted event row (domain fields + appliedQuantity)
   */
  async function commit({
    event,
    appliedQuantity,
    nextQuantity,
    expectedCurrentQuantity,
    product,
  }) {
    // --- Pre-transaction shape checks ---------------------------------------
    if (!event || typeof event !== 'object' || !event.id) {
      throw new InvalidStockEventError('expected a non-null object with an id field');
    }
    if (!product || typeof product !== 'object' || !product.id) {
      throw new InvalidProductError('expected a non-null object with an id field');
    }

    // --- Atomic transaction -------------------------------------------------
    //
    // Tables explicitly declared in scope:
    //   db.stockEvents  — the new event row
    //   db.products     — the updated materialized quantity
    //   db.syncQueue    — one stockEvent insert + one product upsert
    //
    // All three tables are named. A write to a table outside the declared
    // scope would not be rolled back on abort — that is exactly the class
    // of bug this explicit list exists to prevent.

    await db.transaction(
      'rw',
      db.stockEvents,
      db.products,
      db.syncQueue,
      async () => {
        // 1. Load current product — must exist
        const currentProduct = await db.products.get(product.id);
        if (!currentProduct) {
          throw new ProductNotFoundError(product.id);
        }

        // 2. Verify quantity has not changed since the service read it
        if (currentProduct.quantity !== expectedCurrentQuantity) {
          throw new QuantityConsistencyError(
            expectedCurrentQuantity,
            currentProduct.quantity
          );
        }

        // 3. Persist the event with appliedQuantity as a storage-layer column
        //    (appliedQuantity is NOT on the domain StockEvent shape — it is
        //    added here, at the persistence boundary, for reversal correctness)
        await db.stockEvents.add({ ...event, appliedQuantity });

        // 4. Update the materialized product quantity
        await db.products.put({ ...product, quantity: nextQuantity });

        // 5. Enqueue the stockEvent sync entry (appliedQuantity +
        //    expectedCurrentQuantity in payload -- both storage-layer
        //    fields, neither on the domain StockEvent shape)
        await db.syncQueue.add(
          buildStockEventSyncEntry(event, appliedQuantity, expectedCurrentQuantity)
        );

        // 6. Enqueue the product state sync entry (fresh clientId)
        await db.syncQueue.add(buildProductSyncEntry(product, nextQuantity));
      }
    );

    return { ...event, appliedQuantity };
  }

  // -------------------------------------------------------------------------
  // commitReversal
  // -------------------------------------------------------------------------

  /**
   * Atomically commit a reversal of an existing stock event.
   *
   * Four logical writes inside one three-table transaction:
   *   1. Insert the new reversal event (+ appliedQuantity column)
   *   2. Patch the original event's reversedBy field
   *   3. Update the product's materialized quantity
   *   4. Enqueue sync entries (reversal event insert + product upsert)
   *
   * The service is responsible for:
   *   - loading the original event via getById() to obtain storedAppliedQuantity
   *   - calling createReversalEvent(originalEvent, storedAppliedQuantity)
   *   - calling applyStockEvent(product.quantity, reversalEvent) to produce
   *     nextQuantity, appliedQuantity, and expectedCurrentQuantity
   *
   * The repository re-reads the original event inside the transaction and
   * re-checks reversedBy, catching any concurrent reversal that may have
   * occurred between the service's canBeReversed() check and this commit.
   *
   * Remote convergence of the reversedBy pointer requires no separate
   * sync queue entry here — confirmed by Phase 6B0's cross-boundary
   * verification (see docs/PROGRESS.md). The reversal event's own queue
   * entry carries reversalOf, which is sufficient for the backend's
   * PUT /api/stock-events/:id transaction to derive and persist the
   * original event's reversedBy atomically, server-side.
   *
   * Transaction tables: db.stockEvents, db.products, db.syncQueue
   *
   * @param {object} params
   * @param {object}  params.reversalEvent          Reversal event (from createReversalEvent)
   * @param {number}  params.appliedQuantity        True applied delta for the reversal
   * @param {string}  params.originalEventId        ID of the event being reversed
   * @param {number}  params.nextQuantity           New product quantity after reversal
   * @param {number}  params.expectedCurrentQuantity Product quantity at service read time
   * @param {object}  params.product               Current product object
   * @returns {Promise<object>} The persisted reversal event row
   */
  async function commitReversal({
    reversalEvent,
    appliedQuantity,
    originalEventId,
    nextQuantity,
    expectedCurrentQuantity,
    product,
  }) {
    // --- Pre-transaction shape checks ---------------------------------------
    if (!reversalEvent || typeof reversalEvent !== 'object' || !reversalEvent.id) {
      throw new InvalidStockEventError(
        'reversalEvent must be a non-null object with an id field'
      );
    }
    if (typeof originalEventId !== 'string' || originalEventId.trim().length === 0) {
      throw new InvalidStockEventError('originalEventId must be a non-empty string');
    }

    // Referential consistency: the supplied reversalEvent and originalEventId
    // must agree before any DB access. This is a repository-level check, not
    // domain validation — we are confirming the pieces assembled by the
    // service are internally consistent.
    if (reversalEvent.reversalOf !== originalEventId) {
      throw new ReversalReferenceError(reversalEvent.reversalOf, originalEventId);
    }

    if (!product || typeof product !== 'object' || !product.id) {
      throw new InvalidProductError('expected a non-null object with an id field');
    }

    // --- Atomic transaction -------------------------------------------------

    await db.transaction(
      'rw',
      db.stockEvents,
      db.products,
      db.syncQueue,
      async () => {
        // 1. Load the authoritative original event from the DB
        const storedOriginal = await db.stockEvents.get(originalEventId);
        if (!storedOriginal) {
          throw new StockEventNotFoundError(originalEventId);
        }

        // 2. Re-check reversedBy inside the transaction — the service called
        //    canBeReversed() before this, but that was outside the transaction.
        //    Another concurrent write could have set reversedBy between then
        //    and now. Reading inside the transaction makes this check atomic.
        if (storedOriginal.reversedBy !== null) {
          throw new AlreadyReversedError(originalEventId);
        }

        // 3. Load current product — must exist
        const currentProduct = await db.products.get(product.id);
        if (!currentProduct) {
          throw new ProductNotFoundError(product.id);
        }

        // 4. Verify quantity has not changed since the service read it
        if (currentProduct.quantity !== expectedCurrentQuantity) {
          throw new QuantityConsistencyError(
            expectedCurrentQuantity,
            currentProduct.quantity
          );
        }

        // 5. Insert the reversal event row (+ appliedQuantity column)
        await db.stockEvents.add({ ...reversalEvent, appliedQuantity });

        // 6. Patch reversedBy on the original event — the one narrow mutation
        //    permitted on an existing stock event row, exactly analogous to
        //    the ProductChangeEvent.accepted exception in ARCHITECTURE.md.
        //    We use the row we loaded inside this transaction (storedOriginal)
        //    rather than the caller-supplied originalEvent object, to ensure
        //    we are patching the current authoritative state.
        await db.stockEvents.put({ ...storedOriginal, reversedBy: reversalEvent.id });

        // 7. Update the materialized product quantity
        await db.products.put({ ...product, quantity: nextQuantity });

        // 8. Enqueue the reversal event sync entry (appliedQuantity +
        //    expectedCurrentQuantity in payload)
        await db.syncQueue.add(
          buildStockEventSyncEntry(reversalEvent, appliedQuantity, expectedCurrentQuantity)
        );

        // 9. Enqueue the product state sync entry (fresh clientId)
        await db.syncQueue.add(buildProductSyncEntry(product, nextQuantity));
      }
    );

    return { ...reversalEvent, appliedQuantity };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    getById,
    getByProductId,
    commit,
    commitReversal,
  };
}
