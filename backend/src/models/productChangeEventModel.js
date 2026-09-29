// ProductChangeEvent model -- Phase 5F.
//
// _id strategy: entityId-as-_id, identical to StockEvent
// (stockEventModel.js) -- ProductChangeEvent._id = client's event.id,
// always taken from the URL parameter, and doubles as the idempotency
// key for this insert-only collection (no separate clientId field, same
// reasoning as StockEvent: for an insert-only collection keyed by
// entityId, existence-by-id already answers "has this been processed").
//
// Scope, per the locked Phase 5F contract: this collection is a pure
// historical record of client-decided Product field changes. The server
// NEVER diffs Products, NEVER generates these events, and NEVER mutates
// the Product this event references -- see productModel.js's own header
// comment for the fuller story of why (the Phase 5D scope correction).
// This model exists purely to accept and persist an already-complete,
// already-decided event the client constructed via its own
// buildChangeEvents().
//
// Shape mirrors frontend/src/services/productService.js's
// ProductChangeEvent output exactly: { id, productId, field, oldValue,
// newValue, timestamp, accepted }, plus ownerId (server-owned, same
// pattern as every other collection).
//
// `field` is a closed enum matching TRACKED_FIELD_MAP's values exactly
// (verified against frontend/src/services/productService.js before
// writing this, not re-derived independently) -- these are the ONLY six
// Product fields this project's domain considers tracked-for-history.
//
// `accepted` (Phase 6E-1d) is NOT stored. It is derived at read time by
// comparing this event's (timestamp, id) against the Product's
// server-authoritative fieldTimestamps[field] -- see
// productChangeEventService.js. Earlier (Phase 5F) it was stored as
// always-true; legacy documents may still carry that stale value, which
// is never read.

import mongoose from 'mongoose';

const TRACKED_CHANGE_EVENT_FIELDS = [
  'name',
  'category',
  'location',
  'tags',
  'sellingPrice',
  'archived'
];

const productChangeEventSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    productId: { type: String, required: true },
    field: { type: String, required: true, enum: TRACKED_CHANGE_EVENT_FIELDS },
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, required: true }
    // `accepted` is intentionally NOT a stored field (Phase 6E-1d). It is
    // computed at read time from Product.fieldTimestamps -- see
    // productChangeEventService.js.
  },
  { _id: false, versionKey: false }
);

// Supports the two query shapes the service will issue: ownership-scoped
// listing filtered by product, and looking up a specific event by
// {_id, ownerId} for the idempotency check.
productChangeEventSchema.index({ ownerId: 1, productId: 1, timestamp: 1 });

export const ProductChangeEvent = mongoose.model(
  'ProductChangeEvent',
  productChangeEventSchema,
  'productChangeEvents'
);

export { TRACKED_CHANGE_EVENT_FIELDS };
