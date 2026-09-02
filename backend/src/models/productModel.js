// Product model -- Phase 5D.
//
// Scope, per the corrected/locked Phase 5D contract: Product persistence
// ONLY. ProductChangeEvent persistence was originally drafted as part of
// this phase, then explicitly reverted -- ProductChangeEvent.id is
// client-generated (see docs/ARCHITECTURE.md "entityId vs. clientId"),
// and the client already constructs fully-formed ProductChangeEvent
// objects before they ever reach the server (see frontend's
// productService.js buildChangeEvents()). A server that diffs Products
// and invents its own change events would create a second, competing
// authority for the same historical record. ProductChangeEvent
// persistence is deferred to its own later slice (5F in the revised
// roadmap), where it will accept already-constructed event payloads with
// their client-assigned identity preserved, not synthesize new ones.
//
// _id strategy: entityId-as-_id, same convention as classifications
// (classificationModel.js) -- Product._id = client's Product.id, always
// taken from the URL parameter, never generated server-side.
//
// Shape mirrors frontend/src/domain/product/productFactory.js's Product
// exactly, plus ownerId/updatedAt (server-owned, same pattern as
// classifications). `quantity` IS persisted (it's the materialized value,
// same as the client's own Dexie row) but is NEVER settable through the
// generic product upsert -- see productService.js's
// assertNoQuantityInPayload(). The schema itself does not enforce this;
// it's a service-layer invariant, same division of responsibility as
// classificationService.js's identity rule living in the service, not
// the schema.

import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    name: { type: String, default: null },
    photoRef: { type: String, default: null },
    quantity: { type: Number, required: true, default: 0 },
    unitId: { type: String, default: null },
    lowStockThreshold: { type: Number, default: null },
    lowStockDisabled: { type: Boolean, required: true, default: false },
    categoryId: { type: String, default: null },
    locationIds: { type: [String], required: true, default: [] },
    tagIds: { type: [String], required: true, default: [] },
    sellingPrice: { type: Number, default: null },
    marginOverride: { type: Number, default: null },
    latestPurchaseDate: { type: String, default: null },
    notes: { type: String, default: null },
    archived: { type: Boolean, required: true, default: false },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { _id: false, versionKey: false }
);

productSchema.index({ ownerId: 1, archived: 1 });

export const Product = mongoose.model('Product', productSchema, 'products');
