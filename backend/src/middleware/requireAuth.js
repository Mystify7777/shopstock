// requireAuth -- Express middleware enforcing a valid access-token
// Authorization header. Stateless: verifies JWT signature/expiry only,
// no database read on ordinary verification (locked contract). Attaches
// `req.user = { id }` for downstream handlers/ownership scoping.
//
// SECURITY: never logs the raw Authorization header or the token itself,
// on the success or failure path.

import { verifyAccessToken } from '../services/tokenService.js';
import { AppError } from './AppError.js';

/**
 * @param {{ secret: string }} config
 * @returns {import('express').RequestHandler}
 */
export function requireAuth(config) {
  return function requireAuthMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      next(new AppError('UNAUTHORIZED', 'Authentication required.'));
      return;
    }

    const token = header.slice('Bearer '.length);

    try {
      const decoded = verifyAccessToken({ token, secret: config.secret });
      req.user = { id: decoded.sub };
      next();
    } catch {
      // Deliberately no `err` binding -- never even risk logging the
      // underlying jsonwebtoken error, which could include the token
      // fragment in some failure modes.
      next(new AppError('UNAUTHORIZED', 'Invalid or expired access token.'));
    }
  };
}
