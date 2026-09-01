// Rate-limit configuration for authentication endpoints. Isolated here
// (not inlined in route files) so the limits are easy to find and tune
// without hunting through route code. Applied to POST /login and
// POST /refresh only -- NOT /password, which is a separate authenticated
// operation with different abuse characteristics (an attacker without a
// valid access token cannot reach it at all).

import rateLimit from 'express-rate-limit';

// Deliberately conservative starting values -- no PRD/architecture
// guidance exists to derive a "correct" number from, so these are a
// reasonable default rather than a researched decision. Easy to tune
// later; isolated here specifically so that tuning doesn't require
// touching route logic.
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const AUTH_RATE_LIMIT_MAX_REQUESTS = 10; // per IP, per window

export const authRateLimiter = rateLimit({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }
  }
});
