// Public resource: /api/categories. Thin wrapper over the shared
// classification router factory -- see classificationRouterFactory.js
// for the actual GET / PUT wiring.

import { createClassificationRouter } from './classificationRouterFactory.js';
import { Category } from '../models/classificationModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createCategoryRouter(config) {
  return createClassificationRouter(Category, config);
}
