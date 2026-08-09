// Client-side ID generation.
//
// Every syncable entity (Product, StockEvent, ProductChangeEvent, Category,
// Location, Tag, Unit) gets its `id` from here at creation time, on-device,
// before it ever touches IndexedDB or the server. This is what lets the
// same id serve as the sync `clientId` — the server never assigns identity,
// it only ever receives an id that was already decided offline.
//
// Why not let the database assign ids?
// Because writes must succeed fully offline (PRD §30/§40), and two devices
// might create records "at the same time" while both offline. Client-
// generated UUIDs make that safe: no coordination is needed to avoid
// collisions, and the same id round-trips through the whole sync pipeline
// unchanged.

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a new unique id for a domain entity.
 *
 * Uses UUID v4 (random). Collision probability is astronomically low
 * (RFC 4122) — safe for a single small shop's dataset without any
 * server-side uniqueness check at creation time.
 *
 * @returns {string} A new UUID v4 string, e.g. "3fa85f64-5717-4562-b3fc-2c963f66afa6"
 */
export function generateId() {
  return uuidv4();
}

/**
 * Basic shape check for a value that's supposed to be one of our ids.
 *
 * Deliberately loose (not a strict UUID-v4 regex): the goal is to catch
 * obvious programmer mistakes (undefined, empty string, a number, an
 * object) early with a clear error, not to police RFC compliance. Being
 * too strict here would make it annoying to use e.g. deterministic test
 * fixture ids like "test-product-1".
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
