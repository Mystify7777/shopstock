import { describe, it, expect } from 'vitest';
import { summarizeInventory, toActivityEntry } from './dashboardSummary.js';
import { classifyStockStatus, STOCK_STATUS } from '../classification/lowStock.js';

const THRESHOLD = 5;
let n = 0;
function product(overrides = {}) {
  n += 1;
  return {
    id: `p${n}`,
    name: `Product ${n}`,
    quantity: 10,
    sellingPrice: null,
    lowStockThreshold: null,
    lowStockDisabled: false,
    archived: false,
    ...overrides
  };
}
const summarize = (products) => summarizeInventory(products, { globalDefaultThreshold: THRESHOLD });

describe('summarizeInventory', () => {
  describe('empty and malformed input', () => {
    it('summarizes no products as all zeros with no value', () => {
      expect(summarize([])).toEqual({
        totalProducts: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        lowStock: [],
        outOfStock: [],
        expectedSellingValue: null
      });
    });

    it('rejects a non-array', () => {
      expect(() => summarizeInventory(null, { globalDefaultThreshold: 5 })).toThrow(TypeError);
      expect(() => summarizeInventory(undefined, { globalDefaultThreshold: 5 })).toThrow(TypeError);
    });

    it('surfaces a malformed stored quantity instead of silently skipping the product', () => {
      expect(() => summarize([product({ quantity: -1 })])).toThrow(TypeError);
      expect(() => summarize([product({ quantity: 'ten' })])).toThrow(TypeError);
    });
  });

  describe('archived exclusion', () => {
    it('excludes archived products from every figure', () => {
      const result = summarize([
        product({ quantity: 10 }),
        product({ quantity: 0, archived: true }),
        product({ quantity: 2, archived: true }),
        product({ quantity: 3, sellingPrice: 100, archived: true })
      ]);
      expect(result.totalProducts).toBe(1);
      expect(result.outOfStockCount).toBe(0);
      expect(result.lowStockCount).toBe(0);
      expect(result.expectedSellingValue).toBeNull();
    });
  });

  describe('stock status (reuses classifyStockStatus)', () => {
    it('counts and groups out-of-stock (quantity 0) and low-stock products', () => {
      const out = product({ quantity: 0 });
      const low = product({ quantity: 3 });
      const ok = product({ quantity: 50 });
      const result = summarize([out, low, ok]);
      expect(result.outOfStock).toEqual([out]);
      expect(result.lowStock).toEqual([low]);
      expect(result.outOfStockCount).toBe(1);
      expect(result.lowStockCount).toBe(1);
      expect(result.totalProducts).toBe(3);
    });

    it('treats quantity === threshold as Low Stock (inclusive, per lowStock.js)', () => {
      expect(summarize([product({ quantity: THRESHOLD })]).lowStockCount).toBe(1);
      expect(summarize([product({ quantity: THRESHOLD + 1 })]).lowStockCount).toBe(0);
    });

    it('honors a per-product threshold override', () => {
      const result = summarize([product({ quantity: 8, lowStockThreshold: 10 })]);
      expect(result.lowStockCount).toBe(1);
    });

    it('never reports a low-stock-disabled product as Low, but zero is still Out', () => {
      const result = summarize([
        product({ quantity: 2, lowStockDisabled: true }),
        product({ quantity: 0, lowStockDisabled: true })
      ]);
      expect(result.lowStockCount).toBe(0);
      expect(result.outOfStockCount).toBe(1);
    });

    it('agrees with classifyStockStatus for every product (no private classification)', () => {
      const products = [0, 1, 4.5, 5, 5.5, 6, 100].map((quantity) => product({ quantity }));
      const result = summarize(products);
      for (const p of products) {
        const status = classifyStockStatus({
          quantity: p.quantity,
          globalDefaultThreshold: THRESHOLD,
          productThresholdOverride: p.lowStockThreshold,
          lowStockDisabled: p.lowStockDisabled
        });
        expect(result.lowStock.includes(p)).toBe(status === STOCK_STATUS.LOW);
        expect(result.outOfStock.includes(p)).toBe(status === STOCK_STATUS.OUT);
      }
    });

    it('keeps the groups disjoint', () => {
      const result = summarize([0, 1, 2, 3, 9].map((quantity) => product({ quantity })));
      const lowIds = new Set(result.lowStock.map((p) => p.id));
      expect(result.outOfStock.some((p) => lowIds.has(p.id))).toBe(false);
    });
  });

  describe('attention group ordering (deterministic)', () => {
    it('lists low stock lowest quantity first, ties by name', () => {
      const b = product({ name: 'Bravo', quantity: 2 });
      const a = product({ name: 'alpha', quantity: 2 });
      const c = product({ name: 'Charlie', quantity: 1 });
      expect(summarize([b, a, c]).lowStock).toEqual([c, a, b]);
    });

    it('lists out of stock by name, case-insensitively, unnamed products as "Unnamed product"', () => {
      const z = product({ name: 'Zeta', quantity: 0 });
      const a = product({ name: 'alpha', quantity: 0 });
      const unnamed = product({ name: null, quantity: 0 });
      const result = summarize([z, unnamed, a]);
      expect(result.outOfStock).toEqual([a, unnamed, z]);
    });

    it('is stable regardless of input order', () => {
      const items = ['d', 'a', 'c', 'b'].map((name) => product({ name, quantity: 0 }));
      const forward = summarize(items).outOfStock.map((p) => p.id);
      const reversed = summarize([...items].reverse()).outOfStock.map((p) => p.id);
      expect(reversed).toEqual(forward);
    });
  });

  describe('expected selling value', () => {
    it('is null when no active product has a price', () => {
      expect(summarize([product(), product()]).expectedSellingValue).toBeNull();
    });

    it('sums quantity x price over priced products and counts the unpriced ones left out', () => {
      const result = summarize([
        product({ quantity: 10, sellingPrice: 12 }),
        product({ quantity: 2.5, sellingPrice: 40 }),
        product({ quantity: 7, sellingPrice: null })
      ]);
      expect(result.expectedSellingValue).toEqual({
        total: 10 * 12 + 2.5 * 40,
        pricedCount: 2,
        unpricedCount: 1
      });
    });

    it('does not treat a missing price as zero', () => {
      const result = summarize([product({ quantity: 10, sellingPrice: 5 }), product({ quantity: 99 })]);
      expect(result.expectedSellingValue.total).toBe(50);
      expect(result.expectedSellingValue.unpricedCount).toBe(1);
    });

    it('counts a priced product with no stock as priced (contributing 0)', () => {
      const result = summarize([product({ quantity: 0, sellingPrice: 30 })]);
      expect(result.expectedSellingValue).toEqual({ total: 0, pricedCount: 1, unpricedCount: 0 });
    });

    it('excludes archived products from value and counts', () => {
      const result = summarize([
        product({ quantity: 1, sellingPrice: 10 }),
        product({ quantity: 100, sellingPrice: 10, archived: true })
      ]);
      expect(result.expectedSellingValue.total).toBe(10);
    });
  });

  it('does not mutate its input', () => {
    const products = [product({ quantity: 0 }), product({ quantity: 3 })];
    const snapshot = JSON.parse(JSON.stringify(products));
    summarize(products);
    expect(products).toEqual(snapshot);
  });
});

describe('toActivityEntry', () => {
  const base = { id: 'e1', productId: 'p1', recordedAt: '2026-09-01T10:00:00.000Z', reversalOf: null };

  it('describes an ADD by its quantity', () => {
    expect(toActivityEntry({ ...base, type: 'ADD', quantity: 20, appliedQuantity: 20 })).toEqual({
      id: 'e1',
      productId: 'p1',
      direction: 'added',
      amount: 20,
      isReversal: false,
      recordedAt: base.recordedAt
    });
  });

  it('describes a REMOVE by what was actually removed, not what was requested', () => {
    const entry = toActivityEntry({ ...base, type: 'REMOVE', quantity: 8, appliedQuantity: 5 });
    expect(entry.direction).toBe('removed');
    expect(entry.amount).toBe(5);
  });

  it('falls back to the requested quantity when appliedQuantity is absent', () => {
    expect(toActivityEntry({ ...base, type: 'REMOVE', quantity: 3 }).amount).toBe(3);
  });

  it('flags reversals', () => {
    expect(toActivityEntry({ ...base, type: 'ADD', quantity: 3, appliedQuantity: 3, reversalOf: 'e0' }).isReversal).toBe(true);
    expect(toActivityEntry({ ...base, type: 'ADD', quantity: 3, appliedQuantity: 3, reversalOf: null }).isReversal).toBe(false);
  });
});
