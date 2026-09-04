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
import { createProductRouter } from './routes/productRoutes.js';
import { createStockEventRouter } from './routes/stockEventRoutes.js';

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

  // Shared { jwtAccessSecret } shape used by every router factory below
  // that needs requireAuth but nothing else from options.
  const routerAuthConfig = { jwtAccessSecret: options.jwtAccessSecret };

  // Phase 5C: classification routers (categories/locations/tags/units).
  // Each is an explicit public resource path per the Phase 5C
  // authorization -- no generic /api/classifications/:type endpoint --
  // even though they all share the same router/service/controller
  // factory internally (see routes/classificationRouterFactory.js).
  app.use('/api/categories', createCategoryRouter(routerAuthConfig));
  app.use('/api/locations', createLocationRouter(routerAuthConfig));
  app.use('/api/tags', createTagRouter(routerAuthConfig));
  app.use('/api/units', createUnitRouter(routerAuthConfig));

  // Phase 5D: Product persistence. Product ONLY -- ProductChangeEvent
  // persistence was deliberately reverted out of this phase (see
  // productModel.js's header comment) and is deferred to its own later
  // slice, since ProductChangeEvent.id is client-generated and arrives
  // as a separate sync entityType, not something this endpoint should
  // diff/invent server-side.
  app.use('/api/products', createProductRouter(routerAuthConfig));

  // Phase 5E: StockEvent processing -- the ONLY backend-controlled path
  // for mutating Product.quantity. See stockEventService.js's header for
  // the locked transaction ordering (idempotency check first, before
  // the optimistic-concurrency check, so a retried request that already
  // succeeded is never rejected merely because its first execution
  // already advanced the inventory).
  app.use('/api/stock-events', createStockEventRouter(routerAuthConfig));

  // Remaining domain routers (product-change-events) are mounted here in
  // a later Phase 5 slice. Intentionally not present yet.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
