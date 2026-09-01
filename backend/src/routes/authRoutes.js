// Auth router. Rate limiting (authRateLimiter) applies ONLY to
// /login and /refresh -- NOT /logout (no abuse-relevant secret being
// brute-forced there; an attacker still needs a real refresh token to
// do anything) and NOT /password (already behind requireAuth, a
// different abuse profile, per the locked contract).

import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { authRateLimiter } from '../middleware/authRateLimiter.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * @param {ReturnType<import('../services/authService.js').createAuthService>} authService
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createAuthRouter(authService, config) {
  const router = Router();
  const controller = createAuthController(authService);
  const auth = requireAuth({ secret: config.jwtAccessSecret });

  router.post('/login', authRateLimiter, controller.login);
  router.post('/refresh', authRateLimiter, controller.refresh);
  router.post('/logout', controller.logout);
  router.patch('/password', auth, controller.changePassword);

  return router;
}
