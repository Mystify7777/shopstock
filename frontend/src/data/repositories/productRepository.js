// Product repository.
//
// Persistence boundary for Product records. This file owns:
//   - reading products from IndexedDB
//   - writing products to IndexedDB
//   - enqueuing the corresponding sync queue entries atomically
//   - enforcing the repository-level quantity invariant
//
// This file does NOT own:
//   - product validation (validateProduct() — that is the domain/service)
//   - product construction or patching (createProduct/updateProduct — domain)
//   - ProductChangeEvent construction (service orchestration)
//   - cost/margin/low-stock calculations (domain/pricing)
//   - stock event application (stockEventRepository)
//   - sync queue processing, retries, or network (sync engine, Phase 6)
//
// See docs/ARCHITECTURE.md:
//   "Tracked vs. non-tracked Product fields"
//   "Atomicity of Product state mutations and their ProductChangeEvents"
//   "entityId vs. clientId"
//   "Product creation and ProductChangeEvent (V1 scope decision)"

import { generateId } from '../../domain/shared/ids.js';
import { timestampNow } from '../../domain/shared/dates.js';

// ---------------------------------------------------------------------------
// Error types
//
// Plain subclasses of Error so callers can instanceof-check if they need to
// distinguish a "product not found" case from a general Dexie failure.
// ---------------------------------------------------------------------------

export class ProductNotFoundError extends Error {
  constructor(id) {
    super(`Product not found: ${id}`);
    this.name = 'ProductNotFoundError';
  }
}

export class QuantityMutationError extends Error {
  constructor(stored, attempted) {
    super(
      `productRepository.update() may not modify quantity. ` +
        `Stored: ${stored}, attempted: ${attempted}. ` +
        `Quantity changes must go through stockEventRepository.`
    );
    this.name = 'QuantityMutationError';
  }
}

export class InvalidChangeEventsError extends Error {
  constructor(reason) {
    super(`changeEvents invalid: ${reason}`);
    this.name = 'InvalidChangeEventsError';
  }
}

export class UnrecognizedListOptionError extends Error {
  constructor(key) {
    super(`list() received unrecognized option: "${key}"`);
    this.name = 'UnrecognizedListOptionError';
  }
}

// ---------------------------------------------------------------------------
// Sync queue helpers (private to this module)
// ---------------------------------------------------------------------------

const RECOGNIZED_LIST_OPTIONS = new Set(['includeArchived']);

/**
 * Build a syncQueue entry for a Product state upsert.
 *
 * entityId = product.id  (stable document identity — the server upserts by
 *                          this key, so all mutations to the same product
 *                          target the same remote document)
 * clientId = generateId() (unique per mutation — prevents the server's
 *                          idempotency check from treating a later mutation
 *                          to the same product as a retry of an earlier one)
 *
 * See docs/ARCHITECTURE.md "entityId vs. clientId".
 */
function buildProductSyncEntry(product) {
  return {
    entityType: 'product',
    operation: 'upsert',
    entityId: product.id,
    clientId: generateId(),       // fresh per mutation — never reuse product.id
    payload: product,
    attempts: 0,
    status: 'pending',
    createdAt: timestampNow(),
    lastError: null
  };
}

/**
 * Build a syncQueue entry for a ProductChangeEvent insert.
 *
 * entityId = event.id   (stable document identity)
 * clientId = event.id   (safe to reuse here: insert-only events represent
 *                        exactly one mutation, so the entity id and the
 *                        mutation id are the same thing)
 *
 * See docs/ARCHITECTURE.md "entityId vs. clientId".
 */
function buildChangeEventSyncEntry(event) {
  return {
    entityType: 'productChangeEvent',
    operation: 'insert',
    entityId: event.id,
    clientId: event.id,           // insert-only: one event = one mutation
    payload: event,
    attempts: 0,
    status: 'pending',
    createdAt: timestampNow(),
    lastError: null
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a product repository backed by the given Dexie database instance.
 *
 * @param {import('dexie').Dexie} db
 */
export function createProductRepository(db) {
  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  /**
   * Return a single Product by primary key, or undefined if not found.
   *
   * No sync side effects.
   *
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async function getById(id) {
    return db.products.get(id);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * Return all products, defaulting to non-archived only.
   *
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<object[]>}
   * @throws {UnrecognizedListOptionError} for any unrecognized option key
   */
  async function list(options = {}) {
    for (const key of Object.keys(options)) {
      if (!RECOGNIZED_LIST_OPTIONS.has(key)) {
        throw new UnrecognizedListOptionError(key);
      }
    }

    const { includeArchived = false } = options;

    if (includeArchived) {
      return db.products.toArray();
    }

    // JS filter rather than an IDB boolean key-range query: the inventory
    // is small, and this avoids any reliance on boolean key-range behavior.
    const all = await db.products.toArray();
    return all.filter((p) => p.archived === false);
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Persist a new Product and enqueue its sync entry.
   *
   * The product must already have been constructed and validated by the
   * domain layer (createProduct()). This repository does not re-validate.
   *
   * Product creation does not generate ProductChangeEvents in V1 — this is
   * an explicit scope decision, not a derived invariant. See
   * docs/ARCHITECTURE.md "Product creation and ProductChangeEvent (V1 scope
   * decision)".
   *
   * Transaction tables: db.products, db.syncQueue
   *
   * @param {object} product
   * @returns {Promise<object>} The persisted product.
   */
  async function create(product) {
    await db.transaction('rw', db.products, db.syncQueue, async () => {
      await db.products.add(product);
      await db.syncQueue.add(buildProductSyncEntry(product));
    });
    return product;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  /**
   * Persist changes to an existing Product and atomically write its
   * ProductChangeEvents and all corresponding sync entries.
   *
   * Pre-conditions checked before entering the transaction:
   *   1. The product already exists (throws ProductNotFoundError if not).
   *   2. product.quantity matches the currently stored quantity exactly
   *      (throws QuantityMutationError if not — quantity changes must go
   *      through stockEventRepository).
   *   3. changeEvents is an array (throws InvalidChangeEventsError if not).
   *   4. Every entry in changeEvents has productId === product.id (throws
   *      InvalidChangeEventsError on mismatch).
   *
   * An empty changeEvents array is valid and expected for edits to non-
   * tracked fields (e.g. notes, marginOverride). See docs/ARCHITECTURE.md
   * "Tracked vs. non-tracked Product fields".
   *
   * Transaction tables: db.products, db.productChangeEvents, db.syncQueue
   *
   * Atomicity: all writes below succeed together or all roll back. A partial
   * failure (e.g. a write to syncQueue after productChangeEvents has already
   * been written) leaves none of them committed.
   *
   * @param {object} product   Already-patched, already-valid domain Product.
   * @param {object[]} [changeEvents]  Already-constructed ProductChangeEvents.
   * @returns {Promise<object>} The persisted product.
   * @throws {ProductNotFoundError}
   * @throws {QuantityMutationError}
   * @throws {InvalidChangeEventsError}
   */
  async function update(product, changeEvents = []) {
    // --- Pre-transaction invariant checks -----------------------------------

    const existing = await db.products.get(product.id);
    if (!existing) {
      throw new ProductNotFoundError(product.id);
    }

    if (product.quantity !== existing.quantity) {
      throw new QuantityMutationError(existing.quantity, product.quantity);
    }

    if (!Array.isArray(changeEvents)) {
      throw new InvalidChangeEventsError(
        `expected an array, got ${typeof changeEvents}`
      );
    }

    for (const event of changeEvents) {
      if (event == null) {
        throw new InvalidChangeEventsError(
          `changeEvents contains a null or undefined entry`
        );
      }
      if (event.productId !== product.id) {
        throw new InvalidChangeEventsError(
          `event.productId "${event.productId}" does not match product.id "${product.id}"`
        );
      }
    }

    // --- Atomic transaction -------------------------------------------------
    //
    // Tables explicitly included in the transaction scope:
    //   db.products           — the product row itself
    //   db.productChangeEvents — one row per tracked-field change
    //   db.syncQueue          — one entry per change event + one for the product
    //
    // All three tables are named here. A transaction that only *appears* atomic
    // because one table is missing from the scope is a latent correctness bug —
    // Dexie silently allows writes to tables outside the transaction's scope,
    // which means those writes are NOT rolled back if the transaction aborts.

    await db.transaction(
      'rw',
      db.products,
      db.productChangeEvents,
      db.syncQueue,
      async () => {
        await db.products.put(product);

        for (const event of changeEvents) {
          await db.productChangeEvents.add(event);
          await db.syncQueue.add(buildChangeEventSyncEntry(event));
        }

        await db.syncQueue.add(buildProductSyncEntry(product));
      }
    );

    return product;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    getById,
    list,
    create,
    update
  };
}