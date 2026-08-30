// The locked Phase 5 error vocabulary (closed set -- see the Phase 5
// contract's "Error vocabulary" section). Route/service code throws an
// AppError with one of these codes; errorHandler.js is the single place
// that turns it into the standard { error: { code, message } } response
// shape. Route handlers never construct a raw Express error response
// directly -- this is the one path.

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  QUANTITY_CONSISTENCY_CONFLICT: 'QUANTITY_CONSISTENCY_CONFLICT',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  DUPLICATE_ENTITY: 'DUPLICATE_ENTITY',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

const DEFAULT_STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUANTITY_CONSISTENCY_CONFLICT: 409,
  ALREADY_REVERSED: 409,
  DUPLICATE_ENTITY: 409,
  INTERNAL_ERROR: 500
};

/**
 * A deliberate, expected API error -- as opposed to an unexpected
 * exception (a real bug, a driver-level failure, etc). Route/service code
 * throws these for every "this specific, anticipated thing went wrong"
 * case; errorHandler.js treats anything that is NOT an AppError as an
 * unexpected failure and reports it as INTERNAL_ERROR without leaking its
 * internal message to the client.
 */
export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code One of the locked vocabulary
   *   codes. Throws if given a code outside that closed set -- the
   *   vocabulary is deliberately not open-ended.
   * @param {string} message Human-readable message, safe to return to
   *   the client as-is.
   * @param {number} [status] HTTP status override; defaults to the
   *   code's standard mapping in DEFAULT_STATUS_BY_CODE.
   */
  constructor(code, message, status) {
    if (!Object.hasOwn(ERROR_CODES, code)) {
      throw new Error(`AppError: "${code}" is not in the locked ERROR_CODES vocabulary.`);
    }
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status || DEFAULT_STATUS_BY_CODE[code];
  }
}
