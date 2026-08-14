// Dexie (IndexedDB) schema definition.
//
// This is the ONLY file that defines `db.version(n).stores(...)` blocks.
// Every schema change is a NEW version block, appended below the previous
// one — never an edit to an existing version() call (docs/ARCHITECTURE.md,
// "Schema migrations are mandatory from day one"). version(1) below is
// permanent once shipped; if it needs to change shape later, that's
// version(2) with its own .upgrade() function, not an edit to this one.
//
// This file only defines SCHEMA (table names + indexed columns). It does
// not contain repository logic, queries, or business rules — see
// data/repositories/ for that. Keeping schema and repository logic in
// separate files means the migration history stays readable on its own,
// without repository code interleaved into it.

import Dexie from 'dexie';

export const DB_NAME = 'shopstock';

export function createDatabase() {
  const db = new Dexie(DB_NAME);

  // ---------------------------------------------------------------------
  // version(1)
  // ---------------------------------------------------------------------
  // Matches docs/ARCHITECTURE.md's "IndexedDB schema (Dexie)" section
  // exactly, with one addition beyond what that section shows:
  // `stockEvents` also has a `reversalOf` index. That column already
  // existed conceptually on every StockEvent (stockEventFactory.js), but
  // ARCHITECTURE.md's example only listed the columns needed for its
  // illustrative purpose — this is the first place the FULL set of
  // indexed columns actually needed by real repository queries gets
  // decided, since that only becomes concrete once repository code exists
  // to need them. `reversalOf` is indexed because reversal.js/history UI
  // will need "find the reversal event for event X" as a fast lookup
  // rather than a full table scan.
  db.version(1).stores({
    products: 'id, name, categoryId, archived, updatedAt',

    // appliedQuantity resolution (docs/ARCHITECTURE.md, "OPEN
    // ARCHITECTURE QUESTION" — now resolved): stored as commit-time
    // metadata ALONGSIDE the event, not as a field the domain layer's
    // StockEvent shape defines. stockEventFactory.js's createAddStockEvent
    // / createRemoveStockEvent never produce an `appliedQuantity` field,
    // and reversal.js still requires it be passed in explicitly — this
    // repository-level column is simply where the repository persists the
    // value it captured from applyStockEvent()'s return at commit time, so
    // it survives app restarts and is available for a later historical
    // reversal (PRD §15) without needing to replay the full event history
    // to recover it. See data/repositories/ (Phase 2, upcoming) for the
    // function that writes it.
    stockEvents: 'id, productId, recordedAt, reversalOf',

    productChangeEvents: 'id, productId, timestamp',
    categories: 'id, archived',
    locations: 'id, archived',
    tags: 'id, archived',
    units: 'id, archived',
    photos: 'id', // blob store, keyed by photoRef
    syncQueue: '++localId, entityType, entityId, status, createdAt',
    session: 'key' // single-row trusted-device token
  });

  return db;
}
