// Centralized error-handling middleware. Mounted LAST in the Express
// middleware chain (app.js), after every route. Produces the single,
// uniform error response shape used across every endpoint:
//
//   { "error": { "code": "...", "message": "human-readable" } }
//
// Route/service code should throw an AppError (see AppError.js) for every
// anticipated failure. Anything else reaching this handler (a genuine bug,
// a driver-level exception, etc) is treated as INTERNAL_ERROR and its raw
// message/stack is logged server-side but never sent to the client --
// leaking internal exception text is an information-disclosure risk, not
// a debugging convenience worth keeping in a response body.

import { AppError, ERROR_CODES } from './AppError.js';

/**
 * 404 handler for routes that don't match anything -- mounted after all
 * real routes, before the error handler. Distinct from AppError's
 * NOT_FOUND (which is for "this specific resource id doesn't exist");
 * this one is for "no route matches this path at all."
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: ERROR_CODES.NOT_FOUND, message: 'No route matches this request.' }
  });
}

/**
 * Express error-handling middleware (4-arg signature is required by
 * Express to be recognized as an error handler, even though `next` is
 * unused here -- this is the terminal handler, it never calls next()).
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message }
    });
    return;
  }

  // Unexpected error -- log the real detail server-side, never send it
  // to the client.
  // eslint-disable-next-line no-console
  console.error('[ShopStock backend] Unhandled error:', err);
  res.status(500).json({
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong.' }
  });
}
