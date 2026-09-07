// Sync request translation — Phase 6A.
//
// Maps a local syncQueue row into a plain description of the HTTP request
// that would deliver it to the Phase 5 backend:
//
//   syncQueue entry  →  createSyncRequest(entry)  →  { method, path, body }
//
// This module owns:
//   - entity-type routing (which endpoint a given entityType targets)
//   - HTTP method mapping (every current Phase 5 write endpoint is PUT /:id)
//   - endpoint/path construction (always keyed by entityId, never clientId
//     — the URL identifies the target document; clientId is retry-attempt
//     identity, carried inside the body instead where the backend expects
//     it, per docs/ARCHITECTURE.md "entityId vs. clientId")
//   - wire-payload serialization: producing a body that satisfies each
//     endpoint's actual backend validator, confirmed field-by-field against
//     the real validation source (classificationService.js,
//     productService.js, stockEventValidation.js,
//     productChangeEventValidation.js) — not assumed from documentation
//
// This module does NOT own:
//   - executing the HTTP request (no fetch/XHR here — that is the API
//     client, a later Phase 6 pass)
//   - queue draining, retries, backoff, or status transitions
//   - authentication / token attachment
//   - conflict resolution or LWW
//
// Local vs. wire distinction (the reason this module exists at all):
// several entities are queued locally with fields the backend's own
// validator explicitly rejects by PRESENCE, regardless of value —
// because those fields are needed for local correctness (a future
// historical reversal, local audit display) but are exclusively
// server-computed or server-owned once a request actually reaches the
// backend. The queue entry itself is left completely untouched; this
// module only ever reads it and returns a new body object.
//
//   product              queued payload includes `quantity`
//                         wire body must NOT include it
//                         (productService.js: assertNoQuantityInPayload)
//
//   stockEvent            queued payload includes `appliedQuantity`
//                         (mandatory locally — see
//                         stockEventRepository.js's own header comment on
//                         why appliedQuantity must be persisted) but the
//                         wire body must NOT include it; `expectedCurrentQuantity`
//                         is required on the wire and must be preserved
//                         from the queue entry, not recomputed here
//                         (stockEventValidation.js: assertNoAppliedQuantityInPayload,
//                         required expectedCurrentQuantity)
//
//   productChangeEvent    queued payload includes `accepted`
//                         wire body must NOT include it
//                         (productChangeEventValidation.js: assertNoAcceptedInPayload)
//
//   category/location/    queued payload is already exactly the shape the
//   tag/unit               backend reads ({ name, archived, isDefault } —
//                         `id` is present locally but the backend ignores
//                         it, since the URL is the identity authority) —
//                         no stripping needed, confirmed by reading
//                         classificationService.js's assertValidPayload().

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class UnknownSyncEntityTypeError extends Error {
  constructor(entityType) {
    super(
      `createSyncRequest: unrecognized entityType "${entityType}". ` +
        `Expected one of: category, location, tag, unit, product, ` +
        `stockEvent, productChangeEvent.`
    );
    this.name = 'UnknownSyncEntityTypeError';
  }
}

// ---------------------------------------------------------------------------
// Endpoint routing — entityType -> { method, basePath }
// ---------------------------------------------------------------------------

const ROUTES = {
  category: { method: 'PUT', basePath: '/api/categories' },
  location: { method: 'PUT', basePath: '/api/locations' },
  tag: { method: 'PUT', basePath: '/api/tags' },
  unit: { method: 'PUT', basePath: '/api/units' },
  product: { method: 'PUT', basePath: '/api/products' },
  stockEvent: { method: 'PUT', basePath: '/api/stock-events' },
  productChangeEvent: { method: 'PUT', basePath: '/api/product-change-events' },
};

// ---------------------------------------------------------------------------
// Wire-body serializers — entityType -> (payload) => body
//
// Each serializer builds a NEW object. None of them mutate the payload
// passed in, and none of them mutate the queue entry the payload came
// from — createSyncRequest() only ever reads `entry`.
// ---------------------------------------------------------------------------

/**
 * Classifications (category/location/tag/unit) — the queued payload
 * already matches what classificationService.js's assertValidPayload()
 * reads ({ name, archived, isDefault }, plus an `id` the backend simply
 * ignores since the URL is the identity authority). No stripping needed;
 * still returns a fresh shallow copy rather than the original reference,
 * so callers can never accidentally mutate the queue entry through the
 * returned body.
 */
function serializeClassificationBody(payload) {
  return { ...payload };
}

/**
 * Product — strips `quantity`, which productService.js's
 * assertNoQuantityInPayload() rejects by presence, regardless of value.
 * Quantity changes reach the backend exclusively through the stockEvent
 * endpoint; the product upsert body must never carry it.
 */
function serializeProductBody(payload) {
  const { quantity, ...body } = payload;
  return body;
}

/**
 * StockEvent — strips `appliedQuantity`, which
 * stockEventValidation.js's assertNoAppliedQuantityInPayload() rejects
 * by presence: the backend always computes its own appliedQuantity from
 * expectedCurrentQuantity/quantity/type, so a client-supplied value is
 * both redundant and explicitly forbidden. `expectedCurrentQuantity` is
 * REQUIRED by the backend and is preserved from the queue entry's
 * payload exactly as captured at commit time — never recomputed here,
 * per the Phase 6A contract (a retry must reuse the exact original
 * value, not a freshly-read one).
 */
function serializeStockEventBody(payload) {
  const { appliedQuantity, ...body } = payload;
  return body;
}

/**
 * ProductChangeEvent — strips `accepted`, which
 * productChangeEventValidation.js's assertNoAcceptedInPayload() rejects
 * by presence (including an explicit `accepted: true`, which is what the
 * client always constructs locally): `accepted` is exclusively
 * server-set in this phase; LWW resolution that could someday set it is
 * a Phase 6 concern the wire contract does not yet support.
 */
function serializeProductChangeEventBody(payload) {
  const { accepted, ...body } = payload;
  return body;
}

const SERIALIZERS = {
  category: serializeClassificationBody,
  location: serializeClassificationBody,
  tag: serializeClassificationBody,
  unit: serializeClassificationBody,
  product: serializeProductBody,
  stockEvent: serializeStockEventBody,
  productChangeEvent: serializeProductChangeEventBody,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a syncQueue entry into a plain description of the HTTP
 * request that would deliver it to the Phase 5 backend. Does not execute
 * the request — no fetch/XHR here; that is a later Phase 6 pass (the API
 * client). Does not mutate `entry` or `entry.payload` in any way.
 *
 * @param {object} entry A full syncQueue row (as produced by any of the
 *   repository buildXSyncEntry() functions): at minimum
 *   { entityType, entityId, payload }. Other queue-transport fields
 *   (localId, clientId, operation, attempts, status, createdAt,
 *   lastError) are present on real rows but are not read by this
 *   function — clientId is the client-generated identity for this
 *   mutation/request, which stays stable across a retry of the same
 *   queued entry where applicable; it is not part of the URL, and the
 *   backend receives it inside the body only where its own contract
 *   already includes it (insert-only entities carry their id as part of
 *   the domain payload itself, e.g. StockEvent.id).
 * @returns {{ method: string, path: string, body: object }}
 * @throws {UnknownSyncEntityTypeError} if entry.entityType is not one of
 *   the seven recognized Phase 5 entity types.
 */
export function createSyncRequest(entry) {
  const { entityType, entityId, payload } = entry;

  const route = ROUTES[entityType];
  const serialize = SERIALIZERS[entityType];
  if (!route || !serialize) {
    throw new UnknownSyncEntityTypeError(entityType);
  }

  return {
    method: route.method,
    path: `${route.basePath}/${entityId}`,
    body: serialize(payload),
  };
}
