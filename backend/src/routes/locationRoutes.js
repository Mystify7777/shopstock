// Public resource: /api/locations. Thin wrapper over the shared
// classification router factory -- see classificationRouterFactory.js
// for the actual GET / PUT wiring.

import { createClassificationRouter } from './classificationRouterFactory.js';
import { Location } from '../models/classificationModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createLocationRouter(config) {
  return createClassificationRouter(Location, config);
}
