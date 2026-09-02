// Public resource: /api/products. GET / and PUT /:id, both behind
// requireAuth, matching the classification routers' shape
// (categoryRoutes.js etc.) -- but products get their own router file
// directly (no shared router-factory abstraction) since there is
// currently only one product-shaped resource, unlike the four
// classification types that justified a shared factory.

import { Router } from 'express';
import { createProductService } from '../services/productService.js';
import { createProductController } from '../controllers/productController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { Product } from '../models/productModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createProductRouter(config) {
  const router = Router();
  const service = createProductService(Product);
  const controller = createProductController(service);
  const auth = requireAuth({ secret: config.jwtAccessSecret });

  router.get('/', auth, controller.list);
  router.put('/:id', auth, controller.upsert);

  return router;
}
