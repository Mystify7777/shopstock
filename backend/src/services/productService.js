// Product persistence service -- Phase 5D, extended in Phase 6E.
//
// Scope: Product persistence, per the corrected/locked Phase 5D contract,
// PLUS Phase 6E's atomic field-level LWW conflict resolution. Does NOT
// diff Products, does NOT generate ProductChangeEvents, and explicitly
// REJECTS a changeEvents payload embedded in the product body (see
// assertNoChangeEventsInPayload() below, and productModel.js's header
// comment for the full "why"). This is a single-document upsert, same
// shape as classificationService.js, not a multi-collection transaction
// -- no session/transaction is needed here for that reason.
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
//   - the fieldMutations invariant (Phase 6E): fieldMutations is
//     TRANSPORT metadata, read to drive the atomic LWW comparison below,
//     but is NEVER itself persisted onto the Product document -- it must
//     not appear as a stored field, the same "transport metadata never
//     pollutes the persisted document" principle already applied to
//     quantity/changeEvents
//   - the URL-vs-body id identity rule (same as classificationService.js)
//   - cross-owner upsert collision handling (same {_id, ownerId} filter +
//     duplicate-key -> CONFLICT pattern as classificationService.js)
//   - Product identity validation (PRD §4.1: name or photoRef required)
//   - Phase 6E: atomic, field-level, timestamp-based last-write-wins for
//     the six LWW-tracked fields (see FIELD_MUTATION_TO_PRODUCT_FIELD
//     below), backed by the server-authoritative `fieldTimestamps` map --
//     see docs/ARCHITECTURE.md's Phase 6E entry for the full locked
//     contract this implements
//
// Does NOT own:
//   - ProductChangeEvent persistence (its own service/endpoint)
//   - stock event / quantity mutation (Phase 5E)
//   - `accepted` computation (productChangeEventService.js, Phase 6E-1d --
//     this file never writes to the ProductChangeEvent collection)
//   - reconciling the losing device's local state (explicitly out of
//     Phase 6E's scope -- see the locked contract's losing-device table)

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

// Phase 6E — maps each LWW-tracked ProductChangeEvent `field` name (the
// key used in the wire payload's `fieldMutations`, and in
// ProductChangeEvent.field / TRACKED_CHANGE_EVENT_FIELDS) to the actual
// Product document field it governs. Three of the six differ from their
// event-field name (categoryId/locationIds/tagIds vs.
// category/location/tags) -- this mapping is the single source of truth
// for that translation, verified against
// backend/src/models/productChangeEventModel.js's TRACKED_CHANGE_EVENT_FIELDS
// and frontend/src/services/productService.js's TRACKED_FIELD_MAP before
// writing this, so the two ends of the wire agree on vocabulary.
const FIELD_MUTATION_TO_PRODUCT_FIELD = {
  name: 'name',
  category: 'categoryId',
  location: 'locationIds',
  tags: 'tagIds',
  sellingPrice: 'sellingPrice',
  archived: 'archived'
};

const LWW_TRACKED_EVENT_FIELDS = Object.keys(FIELD_MUTATION_TO_PRODUCT_FIELD);
const LWW_TRACKED_PRODUCT_FIELDS = new Set(Object.values(FIELD_MUTATION_TO_PRODUCT_FIELD));

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
 * Phase 6E: clients may never directly set fieldTimestamps -- it is
 * exclusively server-maintained authoritative LWW state, computed by the
 * atomic pipeline below from fieldMutations. Same presence-based
 * rejection pattern as quantity/changeEvents.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertNoFieldTimestampsInPayload(payload) {
  if (Object.hasOwn(payload, 'fieldTimestamps')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'fieldTimestamps cannot be set directly. It is server-maintained ' +
        'state, derived from fieldMutations.'
    );
  }
}

/**
 * Phase 6E: validate the shape of fieldMutations, if present. Unlike
 * quantity/changeEvents, fieldMutations IS a legitimate, expected key on
 * this endpoint's payload (it's how the LWW timestamps are transported)
 * -- this function checks its shape, it does not reject its presence.
 * Absent entirely is fine (a mutation that touches no LWW-tracked field,
 * or the create path, which never sends it at all).
 *
 * Note what this does NOT validate: fieldMutations never carries the new
 * VALUE for a field -- only { timestamp, eventId }. The value itself is
 * read from the ordinary payload field (payload.sellingPrice, etc.),
 * exactly like every other patchable field. Conflating the two was a
 * real bug caught during implementation and fixed before this landed --
 * see the "Phase 6E: source the incoming value..." comment in
 * buildLwwPipelineStage() below.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertValidFieldMutations(fieldMutations, payload) {
  if (fieldMutations === undefined) return;
  if (fieldMutations === null || typeof fieldMutations !== 'object' || Array.isArray(fieldMutations)) {
    throw new AppError('VALIDATION_ERROR', 'fieldMutations must be an object.');
  }
  for (const [field, entry] of Object.entries(fieldMutations)) {
    if (!Object.hasOwn(FIELD_MUTATION_TO_PRODUCT_FIELD, field)) {
      throw new AppError('VALIDATION_ERROR', `fieldMutations contains an unrecognized field "${field}".`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('VALIDATION_ERROR', `fieldMutations.${field} must be an object.`);
    }
    if (typeof entry.timestamp !== 'string' || Number.isNaN(new Date(entry.timestamp).getTime())) {
      throw new AppError('VALIDATION_ERROR', `fieldMutations.${field}.timestamp must be a valid ISO timestamp string.`);
    }
    if (typeof entry.eventId !== 'string' || entry.eventId.length === 0) {
      throw new AppError('VALIDATION_ERROR', `fieldMutations.${field}.eventId must be a non-empty string.`);
    }
    // fieldMutations carries only timing/identity metadata, never the
    // value. A mutation entry without its corresponding Product value in
    // the payload is malformed -- the pipeline would otherwise write null.
    const productField = FIELD_MUTATION_TO_PRODUCT_FIELD[field];
    if (!Object.hasOwn(payload, productField)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `fieldMutations.${field} requires the corresponding "${productField}" value in the request body.`
      );
    }
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
  assertNoFieldTimestampsInPayload(payload);
  assertValidFieldMutations(payload.fieldMutations, payload);

  // On an EXISTING product a tracked field only takes effect when its
  // fieldMutations entry is present (Phase 6G locked rule); without one
  // the stored value survives, so identity must be judged against it.
  // `name` is the only tracked field that participates in the identity rule.
  const nameIsAuthoritative =
    Object.hasOwn(payload, 'name') && (!existingProduct || Boolean(payload.fieldMutations?.name));
  const effectiveName = nameIsAuthoritative
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
 * Build the non-LWW portion of the next Product document: every
 * PATCHABLE_FIELD that is NOT one of the six LWW-tracked fields is
 * applied unconditionally (PATCH semantics -- present in payload means
 * apply, absent means leave untouched), exactly as before Phase 6E. The
 * six LWW-tracked fields are deliberately EXCLUDED here -- their
 * accept/reject decision is made entirely inside the atomic pipeline
 * stage built by buildLwwPipelineStage(), never in application code.
 *
 * `quantity` is never touched here -- assertNoQuantityInPayload() has
 * already rejected any payload containing it.
 */
function buildNonLwwPatch(payload) {
  const patch = {};
  for (const field of PATCHABLE_FIELDS) {
    if (LWW_TRACKED_PRODUCT_FIELDS.has(field)) continue;
    if (Object.hasOwn(payload, field)) {
      patch[field] = payload[field];
    }
  }
  return patch;
}

/**
 * Phase 6E — build the aggregation-pipeline $set stage implementing
 * atomic, field-level, timestamp-based LWW for every LWW-tracked field.
 * Genuinely atomic: the comparison AND the write happen inside MongoDB's
 * own single atomic operation (an aggregation-pipeline update, same
 * technique as authService.js's refresh-token rotation), never a
 * read-then-compute-in-JS-then-write -- there is no window in which a
 * concurrent request could observe or race against a partially-applied
 * decision.
 *
 * IMPORTANT — where the incoming VALUE comes from: fieldMutations only
 * ever carries { timestamp, eventId } for each field, never the new
 * value itself (per the locked wire contract). The actual incoming value
 * for a tracked field is read from the payload directly, exactly like
 * every other patchable field (e.g. payload.sellingPrice) -- conflating
 * fieldMutations with the value source was a real bug caught during
 * implementation and is deliberately called out here so it isn't
 * reintroduced.
 *
 * For each LWW-tracked field present in fieldMutations:
 *   - no existing fieldTimestamps[field]  -> accept unconditionally
 *   - incoming.timestamp  >  stored.timestamp  -> accept
 *   - incoming.timestamp  <  stored.timestamp  -> reject (keep existing)
 *   - incoming.timestamp === stored.timestamp  -> accept ($gte, not $gt --
 *     this is what makes "whichever atomic write executes second wins"
 *     the actual behavior: the second write's incoming.timestamp equals
 *     the first write's already-committed stored.timestamp, and $gte
 *     lets it win)
 *
 * A tracked field NOT present in fieldMutations keeps its
 * fieldTimestamps entry unchanged. Its Product value is ALWAYS carried
 * through from the live document on an existing Product (a tracked field
 * has no client authority without its fieldMutations entry -- Phase 6G),
 * and only initialized from the payload on a genuine insert.
 *
 * `fieldTimestamps` is rebuilt as ONE plain object per write (six known,
 * fixed keys -- this project doesn't need a dynamic $setField chain,
 * since the tracked-field set is fixed at code-authoring time, not
 * request-time). An earlier draft of this function tried to build it key
 * by key with $setField and only ever wrote the first key -- fixed here
 * by constructing the whole map in one $set expression instead.
 *
 * @param {object} fieldMutations Validated fieldMutations from the
 *   request payload (may be `undefined` -- treated as `{}`).
 * @param {object} payload The full request payload, for reading each
 *   tracked field's incoming VALUE (separate from fieldMutations, which
 *   only carries timing/identity metadata).
 * @returns {object} One aggregation-pipeline stage, for use as an
 *   element of the `update` array argument to findOneAndUpdate().
 */
const INSERT_MARKER = '__lwwIsInsert';

function buildLwwPipelineStage(fieldMutations = {}, payload = {}) {
  const productFieldUpdates = {};
  const fieldTimestampEntries = {};

  // Stage 1 guarantees $fieldTimestamps is an object, but $ifNull keeps
  // this expression safe on its own too.
  const storedMap = { $ifNull: ['$fieldTimestamps', {}] };

  for (const eventField of LWW_TRACKED_EVENT_FIELDS) {
    const productField = FIELD_MUTATION_TO_PRODUCT_FIELD[eventField];
    const mutation = fieldMutations[eventField];
    // fieldTimestamps is keyed by the EVENT field name (category,
    // location, tags, ...), per the locked contract -- not the Product
    // document field name (categoryId, ...).
    const storedEntryExpr = { $getField: { field: eventField, input: storedMap } };
    const storedTimestampExpr = { $getField: { field: 'timestamp', input: storedEntryExpr } };

    if (!mutation) {
      // Phase 6G locked rule: on an EXISTING document, a tracked field
      // has no client authority without its fieldMutations entry -- the
      // live value survives whether or not the payload carries the field
      // (a stale full-snapshot upsert must never revert a newer LWW
      // value). On a genuine INSERT there is nothing to protect, so the
      // snapshot value initializes the field. fieldTimestamps is untouched.
      productFieldUpdates[productField] = Object.hasOwn(payload, productField)
        ? { $cond: { if: `$${INSERT_MARKER}`, then: { $literal: payload[productField] }, else: `$${productField}` } }
        : `$${productField}`;
      fieldTimestampEntries[eventField] = storedEntryExpr;
      continue;
    }

    // Passed as a JS Date (serialized as a BSON date literal), never a
    // string the pipeline could interpret as a field path.
    const incomingTimestamp = new Date(mutation.timestamp);
    const incomingValue = Object.hasOwn(payload, productField) ? payload[productField] : null;

    // A missing/null stored timestamp means "no prior LWW mutation" ->
    // incoming wins. $type is used instead of comparing to `undefined`,
    // which the driver would drop or serialize as null.
    const acceptCondition = {
      $or: [
        { $in: [{ $type: storedTimestampExpr }, ['missing', 'null']] },
        { $gte: [incomingTimestamp, storedTimestampExpr] }
      ]
    };

    productFieldUpdates[productField] = {
      $cond: { if: acceptCondition, then: { $literal: incomingValue }, else: `$${productField}` }
    };

    fieldTimestampEntries[eventField] = {
      $cond: {
        if: acceptCondition,
        then: { timestamp: incomingTimestamp, eventId: { $literal: mutation.eventId } },
        else: storedEntryExpr
      }
    };
  }

  // Preserve any entries already present that this stage does not manage
  // (defensive: keeps unknown/legacy keys rather than dropping them).
  return {
    $set: {
      ...productFieldUpdates,
      fieldTimestamps: { $mergeObjects: [storedMap, fieldTimestampEntries] }
    }
  };
}

/**
 * Stage 1 of the atomic pipeline: establish defaults and apply the
 * non-LWW patch, using ONLY the current MongoDB document as the source of
 * existing state. Nothing read by the earlier JS pre-read is written back.
 *
 * `$ifNull` distinguishes "field absent/null on the current document"
 * (genuine insert, or a legacy document) from "field has a value" -- so
 * defaults apply on insert and NEVER overwrite an existing value.
 * (Every default here is itself null/false/[]/0/{} or `now`, so treating
 * an explicit null on an existing document as "use the default" is
 * lossless.) Payload values are wrapped in $literal so a string such as
 * "$foo" is stored as text, not evaluated as a field path.
 */
function buildBaseAndPatchStage(ownerId, urlId, nonLwwPatch, now) {
  const set = {
    _id: urlId,
    ownerId,
    name: { $ifNull: ['$name', null] },
    photoRef: { $ifNull: ['$photoRef', null] },
    quantity: { $ifNull: ['$quantity', 0] },
    unitId: { $ifNull: ['$unitId', null] },
    lowStockThreshold: { $ifNull: ['$lowStockThreshold', null] },
    lowStockDisabled: { $ifNull: ['$lowStockDisabled', false] },
    categoryId: { $ifNull: ['$categoryId', null] },
    locationIds: { $ifNull: ['$locationIds', []] },
    tagIds: { $ifNull: ['$tagIds', []] },
    sellingPrice: { $ifNull: ['$sellingPrice', null] },
    marginOverride: { $ifNull: ['$marginOverride', null] },
    latestPurchaseDate: { $ifNull: ['$latestPurchaseDate', null] },
    notes: { $ifNull: ['$notes', null] },
    archived: { $ifNull: ['$archived', false] },
    createdAt: { $ifNull: ['$createdAt', now] },
    fieldTimestamps: { $ifNull: ['$fieldTimestamps', {}] },
    // Temporary marker, evaluated against the INPUT document (before any
    // default above is applied): a genuine insert has no createdAt yet.
    // Removed by the final pipeline stage; never persisted.
    [INSERT_MARKER]: { $eq: [{ $type: '$createdAt' }, 'missing'] }
  };
  for (const [field, value] of Object.entries(nonLwwPatch)) {
    set[field] = { $literal: value };
  }
  return { $set: set };
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
   * future multi-collection slice like stock events, which needs one).
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
    const payload = rawPayload;

    assertIdentityAgreement(urlId, payload && typeof payload === 'object' ? payload.id : undefined);

    const existingProduct = await ProductModel.findOne({ _id: urlId, ownerId }).lean();

    assertValidPayload(payload, existingProduct);

    const now = new Date();
    const { fieldMutations, ...restOfPayload } = payload;
    const nonLwwPatch = buildNonLwwPatch(restOfPayload);

    // The pre-read above is used ONLY for the effective name/photoRef
    // identity check. It is never a source of state for the write:
    // every existing value used by the pipeline is read from the current
    // MongoDB document inside the atomic update itself.
    try {
      const doc = await ProductModel.findOneAndUpdate(
        { _id: urlId, ownerId },
        [
          buildBaseAndPatchStage(ownerId, urlId, nonLwwPatch, now),
          buildLwwPipelineStage(fieldMutations, restOfPayload),
          // Server-owned bookkeeping. quantity is deliberately NOT
          // touched here -- stage 1 already carries the CURRENT
          // document's quantity forward (or 0 on insert), so a
          // concurrent stock event can never be rolled back by this
          // write. updatedAt is server receipt time, never the LWW clock.
          { $set: { _id: urlId, ownerId, updatedAt: now } },
          { $unset: INSERT_MARKER }
        ],
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
