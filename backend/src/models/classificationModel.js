// Shared classification model factory -- Category, Location, Tag, Unit
// all share the exact same persisted shape and semantics (Phase 5C
// locked contract), so one schema factory produces all four Mongoose
// models rather than four hand-duplicated schema definitions.
//
// _id strategy: entityId-as-_id (NOT the User model's ObjectId
// exception -- see models/User.js's own comment on why User is the odd
// one out). The client's generateId() produces the _id value; it always
// arrives via the URL parameter (:id) on PUT, never trusted from the
// request body -- see the Phase 5C authorization's locked body/URL
// identity rule, enforced in the service layer, not here.
//
// ownerId: always server-set from req.user.id, never client-supplied.
// Every query in this project's classification service must filter by
// ownerId -- this schema does not and cannot enforce that on its own;
// it only stores the field. See classificationService.js.
//
// updatedAt: server-set on every write (Date.now()). This is NOT the
// client-driven last-write-wins timestamp described in
// docs/ARCHITECTURE.md's "Metadata conflict semantics" -- true LWW is
// explicitly deferred to Phase 6 per the Phase 5C authorization. For
// now this field only records server-observed write recency.

import mongoose from 'mongoose';

/**
 * Build a Mongoose model for one classification entity type.
 *
 * @param {string} modelName        e.g. 'Category'
 * @param {string} collectionName   e.g. 'categories'
 * @returns {import('mongoose').Model}
 */
function createClassificationModel(modelName, collectionName) {
  const schema = new mongoose.Schema(
    {
      _id: { type: String, required: true },
      ownerId: { type: String, required: true },
      name: { type: String, required: true },
      archived: { type: Boolean, required: true, default: false },
      isDefault: { type: Boolean, required: true, default: false },
      updatedAt: { type: Date, required: true }
    },
    {
      _id: false,       // we supply _id ourselves (String, not ObjectId)
      versionKey: false
    }
  );

  // Supports the two query shapes the service actually issues:
  //   list(ownerId)                    -> { ownerId }
  //   list(ownerId, { includeArchived: false })  -> { ownerId, archived: false }
  schema.index({ ownerId: 1, archived: 1 });

  return mongoose.model(modelName, schema, collectionName);
}

export const Category = createClassificationModel('Category', 'categories');
export const Location = createClassificationModel('Location', 'locations');
export const Tag = createClassificationModel('Tag', 'tags');
export const Unit = createClassificationModel('Unit', 'units');
