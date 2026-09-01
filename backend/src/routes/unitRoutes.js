// Public resource: /api/units. Thin wrapper over the shared
// classification router factory -- see classificationRouterFactory.js
// for the actual GET / PUT wiring.

import { createClassificationRouter } from './classificationRouterFactory.js';
import { Unit } from '../models/classificationModel.js';

/**
 * @param {{ jwtAccessSecret: string }} config
 * @returns {import('express').Router}
 */
export function createUnitRouter(config) {
  return createClassificationRouter(Unit, config);
}
