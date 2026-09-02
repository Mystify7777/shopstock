// Product persistence service -- Phase 5D.
//
// Scope: Product persistence ONLY, per the corrected/locked Phase 5D
// contract. Does NOT diff Products, does NOT generate ProductChangeEvents,
// and explicitly REJECTS a changeEvents payload embedded in the product
// body (see assertNoChangeEventsInPayload() below, and productModel.js's
// header comment for the full "why"). This is a single-document upsert,
// same shape as classificationService.js, not a multi-collection
// transaction -- no session/transaction is needed here for that reason
// (contrast with the reverted draft of this file, which incorrectly
// assumed Product + ProductChangeEvent needed to commit together
// server-side; they don't, because they arrive as separate sync
// operations with separately client-generated identities).
//
// Owns:
//   - ownership-scoped list/upsert for Product
//   - the quantity-rejection invariant: quantity may NEVER appear in a
//     generic upsert payload (create or update), rejected with
//     VALIDATION_ERROR -- the locked contract explicitly assigns this
//     error code, not QUANTITY_CONSISTENCY_CONFLICT (that vocabulary
//     entry exists for a different, not-yet-built scenario in the
//     stock-event slice; an unused constant is not a spec)
//   - the changeEvents-rejection invariant: a changeEvents key present
//     in the payload (create or update, regardless of value -- an empty
//     array is rejected exactly like a populated one) is rejected with
//     VALIDATION_ERROR, never silently accepted or silently ignored
//   - the URL-vs-body id identity rule (same as classificationService.js)
//   - cross-owner upsert collision handling (same {_id, ownerId} filter +
//     duplicate-key -> CONFLICT pattern as classificationService.js)
//   - Product identity validation (PRD §4.1: name or photoRef required)
//
// Does NOT own:
//   - ProductChangeEvent persistence (deferred to its own later slice)
//   - stock event / quantity mutation (Phase 5E, not yet built)
//   - multi-writer LWW conflict resolution (Phase 6)

import { AppError } from '../middleware/AppError.js';

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

const NUMERIC_OR_NULL_FIELDS = ['lowStockThreshold', 'sellingPrice', 'marginOverride'];
const ARRAY_FIELDS = ['locationIds', 'tagIds'];
const STRING_OR_NULL_FIELDS = ['photoRef', 'unitId', 'categoryId', 'latestPurchaseDate', 'notes'];
const BOOLEAN_FIELDS = ['lowStockDisabled', 'archived'];

const PATCHABLE_FIELDS = [
  'name', 'photoRef', 'unitId', 'lowStockThreshold', 'lowStockDisabled',
  'categoryId', 'locationIds', 'tagIds', 'sellingPrice', 'marginOverride',
  'latestPurchaseDate', 'notes', 'archived'
];

/**
 * Validate the identity relationship between the URL :id and an optional
 * body.id -- identical rule to classificationService.js.
 */
function assertIdentityAgreement(urlId, bodyId) {
  if (bodyId === undefined) return;
  if (bodyId === urlId) return;
  throw new AppError(
    'VALIDATION_ERROR',
    `Request body id ("${bodyId}") does not match the URL id ("${urlId}").`
  );
}

/**
 * The quantity-rejection invariant, locked in the Phase 5D contract:
 * `quantity` may never appear in a generic upsert payload, under any
 * value, including 0 or null. Checked by property PRESENCE, not
 * truthiness -- `{ quantity: 0 }` must be rejected exactly like
 * `{ quantity: 5000 }`. Error code is VALIDATION_ERROR, per the locked
 * contract -- not QUANTITY_CONSISTENCY_CONFLICT, which is reserved
 * vocabulary for a different scenario and is not this one just because
 * it exists in the vocabulary.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertNoQuantityInPayload(payload) {
  if (Object.hasOwn(payload, 'quantity')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'quantity cannot be set through the product endpoint. Quantity ' +
        'changes must go through a stock event.'
    );
  }
}

/**
 * The changeEvents-rejection invariant. This is the direct consequence of
 * the corrected Phase 5D scope: ProductChangeEvent.id is client-generated
 * (see docs/ARCHITECTURE.md "entityId vs. clientId") and the client
 * already constructs fully-formed ProductChangeEvent objects before they
 * ever reach the server, as a SEPARATE sync operation
 * (entityType: 'productChangeEvent', not 'product'). If this endpoint
 * silently accepted and ignored an embedded changeEvents array, that
 * would be a quieter version of the exact mistake this phase started
 * with -- the server pretending to have an opinion about change events
 * it has no business generating, reading, or discarding. Rejecting it
 * loudly, by PRESENCE (same pattern as quantity, not truthiness --
 * `{ changeEvents: [] }` is rejected exactly like a populated array),
 * makes the boundary explicit rather than silently swallowing a
 * malformed or premature client request.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertNoChangeEventsInPayload(payload) {
  if (Object.hasOwn(payload, 'changeEvents')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'changeEvents cannot be submitted through the product endpoint. ' +
        'ProductChangeEvent persistence is a separate, not-yet-built ' +
        'endpoint with its own client-generated identity.'
    );
  }
}

/**
 * Validate the mutable Product fields present in the payload. Deliberately
 * limited to the identity rule (PRD §4.1) plus basic type checks -- does
 * not validate that referenced ids (categoryId, unitId, locationIds,
 * tagIds) actually exist, matching the frontend domain validator's own
 * documented scope boundary.
 *
 * @param {object} payload
 * @param {object|null} existingProduct The stored product, for identity
 *   validation on partial updates (a field-only update, e.g. sellingPrice,
 *   must still result in a product that satisfies the identity rule using
 *   whichever of name/photoRef is NOT being changed).
 */
function assertValidPayload(payload, existingProduct) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be an object.');
  }

  assertNoQuantityInPayload(payload);
  assertNoChangeEventsInPayload(payload);

  const effectiveName = Object.hasOwn(payload, 'name')
    ? payload.name
    : existingProduct?.name ?? null;
  const effectivePhotoRef = Object.hasOwn(payload, 'photoRef')
    ? payload.photoRef
    : existingProduct?.photoRef ?? null;

  const hasName = typeof effectiveName === 'string' && effectiveName.trim().length > 0;
  const hasPhoto = typeof effectivePhotoRef === 'string' && effectivePhotoRef.trim().length > 0;
  if (!hasName && !hasPhoto) {
    throw new AppError('VALIDATION_ERROR', 'Product needs a name or photo.');
  }

  if (Object.hasOwn(payload, 'name') && payload.name !== null && typeof payload.name !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'name must be a string or null.');
  }

  for (const field of STRING_OR_NULL_FIELDS) {
    if (Object.hasOwn(payload, field) && payload[field] !== null && typeof payload[field] !== 'string') {
      throw new AppError('VALIDATION_ERROR', `${field} must be a string or null.`);
    }
  }

  for (const field of NUMERIC_OR_NULL_FIELDS) {
    if (Object.hasOwn(payload, field) && payload[field] !== null) {
      if (typeof payload[field] !== 'number' || !Number.isFinite(payload[field])) {
        throw new AppError('VALIDATION_ERROR', `${field} must be a number or null.`);
      }
    }
  }

  for (const field of ARRAY_FIELDS) {
    if (Object.hasOwn(payload, field) && !Array.isArray(payload[field])) {
      throw new AppError('VALIDATION_ERROR', `${field} must be a list.`);
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (Object.hasOwn(payload, field) && typeof payload[field] !== 'boolean') {
      throw new AppError('VALIDATION_ERROR', `${field} must be a boolean.`);
    }
  }
}

/**
 * Merge a validated payload onto the previous state (or defaults, for a
 * genuine create) to build the next Product document. PATCH semantics: a
 * key absent from payload leaves the existing/default value untouched; a
 * key present (including null/''/false) is applied exactly as given.
 * Mirrors the frontend's updateProduct() patch semantics.
 */
function buildNextProductState({ urlId, ownerId, payload, existingProduct, now }) {
  const base = existingProduct ?? {
    _id: urlId,
    ownerId,
    name: null,
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
    archived: false,
    createdAt: now
  };

  const next = { ...base };
  for (const field of PATCHABLE_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      next[field] = payload[field];
    }
  }

  next._id = urlId;
  next.ownerId = ownerId;
  next.updatedAt = now;
  // quantity is never touched here -- assertNoQuantityInPayload() has
  // already rejected any payload containing it. existingProduct's
  // quantity (or 0, for a create) is carried through untouched. This is
  // the ONE field this service deliberately never lets the payload reach,
  // even indirectly.
  next.quantity = base.quantity ?? 0;
  if (next.createdAt == null) {
    next.createdAt = now;
  }

  return next;
}

/**
 * @param {import('mongoose').Model} ProductModel
 */
export function createProductService(ProductModel) {
  async function list(ownerId, options = {}) {
    const { includeArchived = false } = options;
    const filter = includeArchived ? { ownerId } : { ownerId, archived: false };
    return ProductModel.find(filter).lean();
  }

  /**
   * Upsert a Product by entityId, scoped to the given owner. Single-
   * document write -- no transaction/session needed (contrast with a
   * future multi-collection slice like stock events, which will need
   * one).
   *
   * Cross-owner safety: identical pattern to classificationService.js --
   * the update filter matches on { _id: urlId, ownerId } together, NEVER
   * on _id alone. If urlId already exists under a different owner, this
   * filter matches nothing, so the upsert attempts an INSERT that
   * collides with the existing document's _id, producing a duplicate-key
   * error (code 11000) rather than a silent overwrite or silent no-op.
   * That error is caught and translated into an explicit CONFLICT.
   *
   * @param {string} ownerId
   * @param {string} urlId
   * @param {unknown} rawPayload
   * @returns {Promise<object>} the persisted product
   * @throws {AppError} VALIDATION_ERROR | CONFLICT
   */
  async function upsert(ownerId, urlId, rawPayload) {
    const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload
      : rawPayload;

    assertIdentityAgreement(urlId, payload && typeof payload === 'object' ? payload.id : undefined);

    const existingProduct = await ProductModel.findOne({ _id: urlId, ownerId }).lean();

    assertValidPayload(payload, existingProduct);

    const now = new Date();
    const nextProduct = buildNextProductState({ urlId, ownerId, payload, existingProduct, now });

    try {
      const doc = await ProductModel.findOneAndUpdate(
        { _id: urlId, ownerId },
        { $set: nextProduct },
        { upsert: true, new: true, runValidators: true }
      ).lean();
      return doc;
    } catch (err) {
      if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
        throw new AppError(
          'CONFLICT',
          "This id is already in use by another owner's record."
        );
      }
      throw err;
    }
  }

  return { list, upsert };
}
