// Shared router factory for a single classification resource. Produces
// the GET / and PUT /:id pair, both behind requireAuth, for one
// Mongoose model. Used by categoryRoutes.js, locationRoutes.js,
// tagRoutes.js, unitRoutes.js -- each of those files stays a couple of
// lines that just supply the model, keeping the four PUBLIC resource
// paths explicit (/api/categories, /api/locations, /api/tags,
// /api/units) per the Phase 5C authorization, while the actual route
// wiring is not duplicated four times.

import { Router } from 'express';
import { createClassificationService } from '../services/classificationService.js';
import { createClassificationController } from '../controllers/classificationController.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * @param {import('mongoose').Model} Model
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createClassificationRouter(Model, config) {
  const router = Router();
  const service = createClassificationService(Model);
  const controller = createClassificationController(service);
  const auth = requireAuth({ secret: config.jwtAccessSecret });

  router.get('/', auth, controller.list);
  router.put('/:id', auth, controller.upsert);

  return router;
}
