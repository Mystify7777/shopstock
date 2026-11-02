import { describe, it, expect } from 'vitest';
import { ADD_STOCK_INTENT, hasAddStockIntent } from './addStockIntent.js';

describe('Add Stock navigation intent', () => {
  it('recognises exactly the intent the dashboard sends', () => {
    expect(hasAddStockIntent(ADD_STOCK_INTENT)).toBe(true);
    expect(hasAddStockIntent({ openAddStock: true })).toBe(true);
  });

  it('ignores null, undefined, other shapes and look-alike values', () => {
    for (const state of [null, undefined, {}, { openAddStock: false }, { openAddStock: 'true' }, { openAddStock: 1 }, 'openAddStock', 7, [true]]) {
      expect(hasAddStockIntent(state), JSON.stringify(state)).toBe(false);
    }
  });

  it('is immutable, so no caller can change the shared contract by accident', () => {
    expect(Object.isFrozen(ADD_STOCK_INTENT)).toBe(true);
  });
});
