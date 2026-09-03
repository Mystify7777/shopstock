// StockEvent model -- Phase 5E.
//
// _id strategy: entityId-as-_id (same convention as classifications and
// products). StockEvent._id = client's event.id, always taken from the
// URL parameter, and -- unlike Product -- this id doubles as the
// idempotency key: stockEvents are insert-only, so "a document with this
// _id already exists for this owner" IS the retry/duplicate check. There
// is no separate clientId field on this document, per
// docs/ARCHITECTURE.md's confirmed contract ("Server rejects/ignores
// duplicate clientId" for stockEvents -- for an insert-only collection
// keyed by entityId, existence-by-id already answers that question).
//
// Shape mirrors frontend/src/domain/stock/stockEventFactory.js's
// StockEvent exactly, plus:
//   - ownerId (server-owned, same pattern as every other collection)
//   - appliedQuantity (commit-time persistence metadata -- NOT part of
//     the domain StockEvent shape; see applyStockEvent.js's own
//     documented rule that this value can only be captured at the exact
//     moment of application and can never be recovered afterward from
//     the event alone. Required here for the same reason it's required
//     in frontend/src/data/db/schema.js's stockEvents table and in the
//     sync queue payload per ARCHITECTURE.md's appliedQuantity
//     amendment: reversal correctness depends on it surviving every
//     persistence boundary.)
//
// Insert-only: this collection is never updated except for the one
// documented exception -- patching reversedBy on the ORIGINAL event as a
// side effect of a NEW reversal event's own insert (see reversal.js's
// domain contract; the server-side equivalent of this patch happens in
// stockEventService.js, not here).

import mongoose from 'mongoose';

const stockEventSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    productId: { type: String, required: true },
    type: { type: String, required: true, enum: ['ADD', 'REMOVE'] },
    quantity: { type: Number, required: true },
    appliedQuantity: { type: Number, required: true },
    costPerUnit: { type: Number, default: null },
    purchaseDate: { type: String, default: null },
    recordedAt: { type: Date, required: true },
    comment: { type: String, default: null },
    reversalOf: { type: String, default: null },
    reversedBy: { type: String, default: null }
  },
  { _id: false, versionKey: false }
);

// Supports the two query shapes the service will issue: ownership-scoped
// listing filtered by product, and looking up a specific event by
// {_id, ownerId} for the idempotency/reversal-target checks.
stockEventSchema.index({ ownerId: 1, productId: 1, recordedAt: 1 });

export const StockEvent = mongoose.model('StockEvent', stockEventSchema, 'stockEvents');
