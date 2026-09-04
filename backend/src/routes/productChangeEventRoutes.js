// Public resource: /api/product-change-events. GET / (list, ownership-
// scoped, optional ?productId=) and PUT /:id (the single, idempotent
// insert path -- see productChangeEventService.js), both behind
// requireAuth.
//
// No DELETE -- insert-only, per the architecture's "events vs. sync
// state" separation. No PATCH/second-write-path for `accepted` --
// deferred to Phase 6.

import { Router } from 'express';
import { createProductChangeEventService } from '../services/productChangeEventService.js';
import { createProductChangeEventController } from '../controllers/productChangeEventController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { ProductChangeEvent } from '../models/productChangeEventModel.js';
import { Product } from '../models/productModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createProductChangeEventRouter(config) {
  const router = Router();
  const service = createProductChangeEventService(ProductChangeEvent, Product);
  const controller = createProductChangeEventController(service);
  const auth = requireAuth({ secret: config.jwtAccessSecret });

  router.get('/', auth, controller.list);
  router.put('/:id', auth, controller.processEvent);

  return router;
}
