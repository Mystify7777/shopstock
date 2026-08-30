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

/**
 * Build the Express app.
 *
 * @param {{ corsOrigin?: string }} [options] corsOrigin defaults to
 *   allowing no cross-origin requests if omitted (safer default for a
 *   test-constructed app than accidentally wildcarding) -- server.js
 *   always passes the real configured origin explicitly.
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

  // Domain routers (products, stock-events, classifications, auth) are
  // mounted here in later Phase 5 slices (5B onward). Intentionally not
  // present yet in 5A.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
