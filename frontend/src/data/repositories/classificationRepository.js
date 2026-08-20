// Classification repository.
//
// Persistence boundary for Category, Location, Tag, and Unit records.
// All four share the same shape ({ id, name, archived, isDefault }) and the
// same sync semantics (upsert by entityId), so one repository handles all four
// via an entityType parameter.
//
// This file owns:
//   - reading classifications from IndexedDB
//   - writing classifications to IndexedDB
//   - enqueuing the corresponding sync queue entries atomically
//
// This file does NOT own:
//   - classification construction or validation (no factory exists — caller
//     constructs; this repository does not validate business fields)
//   - isDefault enforcement (UI/service concern, not persistence concern)
//   - updatedAt / LWW conflict resolution (deferred to Phase 6/server-sync)
//   - classification change-event history (no such table exists in V1)
//   - sync queue processing, retries, or network (sync engine, Phase 6)
//
// See docs/ARCHITECTURE.md:
//   "entityId vs. clientId"
//   "MongoDB schema" — categories/locations/tags/units upserted by entityId

import { generateId } from '../../domain/shared/ids.js';
import { timestampNow } from '../../domain/shared/dates.js';

// ---------------------------------------------------------------------------
// Valid entity types — the closed set of classification tables in V1.
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = new Set(['category', 'location', 'tag', 'unit']);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class UnknownEntityTypeError extends Error {
  constructor(entityType) {
    super(
      `Unknown classification entity type: "${entityType}". ` +
        `Expected one of: category, location, tag, unit.`
    );
    this.name = 'UnknownEntityTypeError';
  }
}

export class ClassificationNotFoundError extends Error {
  constructor(entityType, id) {
    super(`${entityType} not found: ${id}`);
    this.name = 'ClassificationNotFoundError';
  }
}

export class InvalidClassificationError extends Error {
  constructor(reason) {
    super(`Invalid classification: ${reason}`);
    this.name = 'InvalidClassificationError';
  }
}

export class UnrecognizedListOptionError extends Error {
  constructor(key) {
    super(`list() received unrecognized option: "${key}"`);
    this.name = 'UnrecognizedListOptionError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RECOGNIZED_LIST_OPTIONS = new Set(['includeArchived']);

/**
 * Validate entityType and return the corresponding Dexie table.
 * Always called first — before any classification validation or DB access.
 *
 * @param {import('dexie').Dexie} db
 * @param {string} entityType
 * @returns {import('dexie').Table}
 * @throws {UnknownEntityTypeError}
 */
function tableFor(db, entityType) {
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new UnknownEntityTypeError(entityType);
  }
  // Map is evaluated here, after type is validated, so db table access is
  // always guarded.
  const map = {
    category: db.categories,
    location: db.locations,
    tag:      db.tags,
    unit:     db.units,
  };
  return map[entityType];
}

/**
 * Build a syncQueue upsert entry for a classification mutation.
 *
 * entityId = classification.id  (stable document identity — server upserts
 *                                by this key across all mutations)
 * clientId = generateId()       (fresh per mutation — prevents the server's
 *                                idempotency check treating a later mutation
 *                                as a retry of an earlier one)
 *
 * See docs/ARCHITECTURE.md "entityId vs. clientId".
 */
function buildSyncEntry(entityType, classification) {
  return {
    entityType,
    operation: 'upsert',
    entityId:  classification.id,
    clientId:  generateId(),       // fresh every call — never reuse classification.id
    payload:   classification,
    attempts:  0,
    status:    'pending',
    createdAt: timestampNow(),
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a classification repository backed by the given Dexie database.
 *
 * @param {import('dexie').Dexie} db
 */
export function createClassificationRepository(db) {

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  /**
   * Return a single classification by primary key, or undefined if not found.
   *
   * @param {string} entityType  'category' | 'location' | 'tag' | 'unit'
   * @param {string} id
   * @returns {Promise<object|undefined>}
   * @throws {UnknownEntityTypeError}
   */
  async function getById(entityType, id) {
    const table = tableFor(db, entityType);
    return table.get(id);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * Return classifications of the given type, defaulting to non-archived only.
   *
   * @param {string} entityType
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<object[]>}
   * @throws {UnknownEntityTypeError}
   * @throws {UnrecognizedListOptionError}
   */
  async function list(entityType, options = {}) {
    // entityType validated first, before option validation or DB access.
    const table = tableFor(db, entityType);

    for (const key of Object.keys(options)) {
      if (!RECOGNIZED_LIST_OPTIONS.has(key)) {
        throw new UnrecognizedListOptionError(key);
      }
    }

    const { includeArchived = false } = options;

    const all = await table.toArray();

    if (includeArchived) {
      return all;
    }

    // JS-side filter rather than an IDB boolean key-range query: the dataset
    // is small and this avoids relying on boolean key-range behaviour.
    return all.filter((c) => c.archived === false);
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Persist a new classification and enqueue its sync entry.
   *
   * The classification must already carry { id, name, archived, isDefault }.
   * This repository does not validate business fields.
   *
   * Transaction tables: classification table, db.syncQueue
   *
   * @param {string} entityType
   * @param {object} classification
   * @returns {Promise<object>} The persisted classification.
   * @throws {UnknownEntityTypeError}
   */
  async function create(entityType, classification) {
    // entityType validated first.
    const table = tableFor(db, entityType);

    await db.transaction('rw', table, db.syncQueue, async () => {
      await table.add(classification);
      await db.syncQueue.add(buildSyncEntry(entityType, classification));
    });

    return classification;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  /**
   * Persist changes to an existing classification and enqueue its sync entry.
   *
   * Pre-conditions checked before the transaction:
   *   1. entityType is valid (tableFor throws if not).
   *   2. classification is a non-null object (InvalidClassificationError).
   *   3. The row already exists (ClassificationNotFoundError).
   *
   * No field-level invariants beyond the above — isDefault, name, archived
   * are all caller-owned concerns.
   *
   * Transaction tables: classification table, db.syncQueue
   *
   * @param {string} entityType
   * @param {object} classification  Already-updated classification object.
   * @returns {Promise<object>} The persisted classification.
   * @throws {UnknownEntityTypeError}
   * @throws {InvalidClassificationError}
   * @throws {ClassificationNotFoundError}
   */
  async function update(entityType, classification) {
    // entityType validated first — before touching classification at all.
    const table = tableFor(db, entityType);

    if (classification == null || typeof classification !== 'object') {
      throw new InvalidClassificationError(
        `expected a non-null object, got ${classification === null ? 'null' : typeof classification}`
      );
    }

    const existing = await table.get(classification.id);
    if (!existing) {
      throw new ClassificationNotFoundError(entityType, classification.id);
    }

    await db.transaction('rw', table, db.syncQueue, async () => {
      await table.put(classification);
      await db.syncQueue.add(buildSyncEntry(entityType, classification));
    });

    return classification;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    getById,
    list,
    create,
    update,
  };
}
