// Shared classification service -- business logic for Category, Location,
// Tag, and Unit, all of which share identical persistence semantics
// (Phase 5C locked contract). One factory produces a service instance
// per Mongoose model; controllers/classificationController.js is the
// thin HTTP-shape wrapper around this.
//
// This file owns:
//   - ownership scoping (every query/write filtered by ownerId)
//   - the list() includeArchived default, mirroring the frontend
//     classificationRepository.js's own default (false)
//   - server-set updatedAt on every write
//   - the URL-vs-body id identity rule (locked in the Phase 5C
//     authorization): body.id absent -> valid; body.id === url id ->
//     valid; body.id !== url id -> VALIDATION_ERROR
//   - field validation (name / archived / isDefault) -- deliberately
//     capped to exactly what the authorization specifies, nothing more
//   - the cross-owner upsert conflict: if a PUT targets an :id that
//     already exists under a DIFFERENT ownerId, this must fail loudly
//     (CONFLICT), never silently overwrite and never silently no-op
//
// This file does NOT own:
//   - HTTP request/response shape (controller's job)
//   - routing (router's job)
//   - authentication (requireAuth middleware's job -- req.user.id is
//     assumed already verified by the time ownerId reaches here)

import { AppError } from '../middleware/AppError.js';

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Validate the identity relationship between the URL :id and an
 * optional body.id, per the Phase 5C authorization's locked rule.
 *
 * @param {string} urlId
 * @param {unknown} bodyId
 * @throws {AppError} VALIDATION_ERROR if bodyId is present and disagrees
 *   with urlId.
 */
function assertIdentityAgreement(urlId, bodyId) {
  if (bodyId === undefined) return; // absent -> valid, no body id required
  if (bodyId === urlId) return;      // matches -> valid
  throw new AppError(
    'VALIDATION_ERROR',
    `Request body id ("${bodyId}") does not match the URL id ("${urlId}").`
  );
}

/**
 * Validate the mutable classification fields. Deliberately minimal --
 * do not add length/uniqueness/etc. constraints without inspecting the
 * frontend/domain contract first (see classificationRepository.js,
 * which itself performs no field-level validation and defers entirely
 * to the caller).
 *
 * @param {unknown} payload
 * @returns {{ name: string, archived?: boolean, isDefault?: boolean }}
 * @throws {AppError} VALIDATION_ERROR
 */
function assertValidPayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be an object.');
  }

  const { name, archived, isDefault } = payload;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'name must be a non-empty string.');
  }

  if (archived !== undefined && typeof archived !== 'boolean') {
    throw new AppError('VALIDATION_ERROR', 'archived must be a boolean when provided.');
  }

  if (isDefault !== undefined && typeof isDefault !== 'boolean') {
    throw new AppError('VALIDATION_ERROR', 'isDefault must be a boolean when provided.');
  }

  return { name: name.trim(), archived, isDefault };
}

/**
 * Create a classification service bound to one Mongoose model
 * (Category, Location, Tag, or Unit).
 *
 * @param {import('mongoose').Model} Model
 */
export function createClassificationService(Model) {

  /**
   * List classifications owned by the given user.
   *
   * @param {string} ownerId
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<object[]>}
   */
  async function list(ownerId, options = {}) {
    const { includeArchived = false } = options;

    const filter = includeArchived
      ? { ownerId }
      : { ownerId, archived: false };

    const docs = await Model.find(filter).lean();
    return docs;
  }

  /**
   * Upsert a classification by entityId, scoped to the given owner.
   *
   * Identity rules (locked):
   *   - persisted _id is always urlId, never taken from the body
   *   - ownerId is always the authenticated caller's id
   *   - updatedAt is always server-generated
   *
   * Cross-owner safety: the update filter matches on { _id: urlId,
   * ownerId } together, NEVER on _id alone. If urlId already exists
   * under a different owner, this filter matches nothing, so Mongo's
   * upsert attempts an INSERT with _id: urlId -- which collides with
   * the existing document's _id and throws a duplicate-key error
   * (code 11000) rather than silently overwriting or silently
   * no-oping. That error is caught here and translated into an
   * explicit CONFLICT, per the Phase 5C review note: this is the exact
   * "obedient upsert" trap being deliberately guarded against, not
   * assumed safe.
   *
   * @param {string} ownerId
   * @param {string} urlId
   * @param {unknown} rawPayload
   * @returns {Promise<object>} the persisted document
   * @throws {AppError} VALIDATION_ERROR | CONFLICT
   */
  async function upsert(ownerId, urlId, rawPayload) {
    // Deliberately do NOT coerce a non-object payload into {} before
    // validating -- an earlier version did this, which would have
    // produced a misleading "name must be a non-empty string" message
    // instead of "Request body must be an object" for any caller that
    // passes a non-object rawPayload. In practice express.json()'s
    // default strict mode rejects a bare JSON primitive at the
    // body-parser layer with its own 500 before this function is ever
    // reached over HTTP (verified directly, not assumed -- see the
    // Phase 5C review response) -- an array IS accepted by the parser
    // and is the payload shape that actually exercises this path via
    // HTTP. This fix is kept for the service's own internal
    // consistency and for any future non-HTTP caller, not because a
    // bare-primitive HTTP request can reach it today.
    const bodyId = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload.id
      : undefined;

    assertIdentityAgreement(urlId, bodyId);
    const { name, archived, isDefault } = assertValidPayload(rawPayload);

    const now = new Date();

    const setFields = { name, updatedAt: now };
    if (archived !== undefined) setFields.archived = archived;
    if (isDefault !== undefined) setFields.isDefault = isDefault;

    try {
      const doc = await Model.findOneAndUpdate(
        { _id: urlId, ownerId },
        {
          $set: setFields,
          $setOnInsert: {
            _id: urlId,
            ownerId,
            ...(archived === undefined ? { archived: false } : {}),
            ...(isDefault === undefined ? { isDefault: false } : {})
          }
        },
        { upsert: true, new: true, runValidators: true }
      ).lean();
      return doc;
    } catch (err) {
      if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
        // The (_id, ownerId) filter matched nothing -- either the id
        // doesn't exist yet (fine, would insert) or it exists under a
        // DIFFERENT owner (the case we're guarding against). A
        // duplicate-key error on _id specifically means the latter:
        // some document with this _id already exists and this filter
        // didn't match it, so Mongo tried to insert a new one and
        // collided. Never silently overwrite; never silently no-op.
        throw new AppError(
          'CONFLICT',
          'This id is already in use by another owner\'s record.'
        );
      }
      throw err;
    }
  }

  return { list, upsert };
}
