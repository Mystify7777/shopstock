// Express app assembly. Deliberately separate from server.js: this module
// builds and exports the app WITHOUT calling app.listen() or connecting to
// MongoDB, so tests (via supertest) can exercise real routes/middleware
// in-process without a bound port or a live database connection for the
// routes that don't need one (health, and later: validation-only failure
// paths on protected routes before any DB read happens).
//
// server.js is the only place that (a) loads/validates env, (b) connects
// to MongoDB, and (c) calls app.listen().

import express from 'express';
import cors from 'cors';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { connectionState } from './config/db.js';
import { createAuthService } from './services/authService.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createCategoryRouter } from './routes/categoryRoutes.js';
import { createLocationRouter } from './routes/locationRoutes.js';
import { createTagRouter } from './routes/tagRoutes.js';
import { createUnitRouter } from './routes/unitRoutes.js';

/**
 * Build the Express app.
 *
 * @param {{
 *   corsOrigin?: string,
 *   jwtAccessSecret?: string,
 *   jwtAccessExpiresIn?: string,
 *   refreshTokenExpiresInDays?: number
 * }} [options] corsOrigin defaults to allowing no cross-origin requests
 *   if omitted (safer default for a test-constructed app than
 *   accidentally wildcarding) -- server.js always passes the real
 *   configured origin explicitly. The auth-related options are required
 *   for the auth routes to function correctly; tests that don't exercise
 *   auth routes may omit them, since createApp() itself never reads
 *   process.env directly (all config flows in as an explicit parameter,
 *   consistent with config/env.js's own testability design).
 * @returns {import('express').Express}
 */
export function createApp(options = {}) {
  const app = express();

  app.use(cors({ origin: options.corsOrigin || false }));
  app.use(express.json());

  // GET /api/health -- no auth required (Phase 5 locked contract). Used
  // for deployment/monitoring liveness checks, not part of the domain
  // surface. Reports Mongo connection state as a diagnostic, but does NOT
  // fail the endpoint if Mongo is disconnected -- a health check that
  // itself depends on a database call is a common source of cascading
  // outages; "the HTTP server is up" and "the database is reachable" are
  // reported as separate facts, not collapsed into one boolean.
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      db: connectionState()
    });
  });

  const authService = createAuthService({
    jwtAccessSecret: options.jwtAccessSecret,
    jwtAccessExpiresIn: options.jwtAccessExpiresIn,
    refreshTokenExpiresInDays: options.refreshTokenExpiresInDays
  });
  app.use('/api/auth', createAuthRouter(authService, { jwtAccessSecret: options.jwtAccessSecret }));

  // Phase 5C: classification routers (categories/locations/tags/units).
  // Each is an explicit public resource path per the Phase 5C
  // authorization -- no generic /api/classifications/:type endpoint --
  // even though they all share the same router/service/controller
  // factory internally (see routes/classificationRouterFactory.js).
  const classificationRouterConfig = { jwtAccessSecret: options.jwtAccessSecret };
  app.use('/api/categories', createCategoryRouter(classificationRouterConfig));
  app.use('/api/locations', createLocationRouter(classificationRouterConfig));
  app.use('/api/tags', createTagRouter(classificationRouterConfig));
  app.use('/api/units', createUnitRouter(classificationRouterConfig));

  // Remaining domain routers (products, stock-events) are mounted here
  // in later Phase 5 slices (5D onward). Intentionally not present yet.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
