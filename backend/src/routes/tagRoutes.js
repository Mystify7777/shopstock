// Public resource: /api/tags. Thin wrapper over the shared
// classification router factory -- see classificationRouterFactory.js
// for the actual GET / PUT wiring.

import { createClassificationRouter } from './classificationRouterFactory.js';
import { Tag } from '../models/classificationModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createTagRouter(config) {
  return createClassificationRouter(Tag, config);
}
