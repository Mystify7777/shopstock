// Public resource: /api/stock-events. GET / (list, ownership-scoped,
// optional ?productId= and ?includeReversed=) and PUT /:id (the single
// authoritative quantity-mutation path -- see stockEventService.js),
// both behind requireAuth.
//
// No reversal-specific route -- a reversal is submitted through the
// same PUT /:id as an ordinary event, distinguished only by reversalOf
// being present in the payload, mirroring reversal.js's own domain
// philosophy that reversal is not a separate operation from an ordinary
// stock event.

import { Router } from 'express';
import { createStockEventService } from '../services/stockEventService.js';
import { createStockEventController } from '../controllers/stockEventController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { StockEvent } from '../models/stockEventModel.js';
import { Product } from '../models/productModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createStockEventRouter(config) {
  const router = Router();
  const service = createStockEventService(StockEvent, Product);
  const controller = createStockEventController(service);
  const auth = requireAuth({ secret: config.jwtAccessSecret });

  router.get('/', auth, controller.list);
  router.put('/:id', auth, controller.processEvent);

  return router;
}
