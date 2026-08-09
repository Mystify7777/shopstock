import { describe, it, expect } from 'vitest';
import {
  calculateCostProjection,
  isCostProjectionPartial,
  estimateCostForUnknownStock
} from '../../../src/domain/pricing/costCalculations.js';

// Minimal stock-event builder for these tests. Only the fields
// costCalculations.js actually reads are included.
function addEvent({ quantity, costPerUnit, recordedAt, purchaseDate }) {
  return {
    type: 'ADD',
    quantity,
    costPerUnit: costPerUnit ?? null,
    purchaseDate: purchaseDate ?? null,
    recordedAt
  };
}

function removeEvent({ quantity, recordedAt }) {
  return {
    type: 'REMOVE',
    quantity,
    costPerUnit: null,
    purchaseDate: null,
    recordedAt
  };
}

describe('calculateCostProjection — PRD §17 worked example', () => {
  it('matches the exact worked example: 20×₹50, 10×₹55, 5×unknown', () => {
    const events = [
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' }),
      addEvent({ quantity: 10, costPerUnit: 55, recordedAt: '2026-08-05T09:00:00.000Z' }),
      addEvent({ quantity: 5, costPerUnit: null, recordedAt: '2026-08-07T09:00:00.000Z' })
    ];

    const projection = calculateCostProjection(events);

    expect(projection.latestCost).toBe(55);
    expect(projection.knownCostQuantity).toBe(30);
    expect(projection.totalQuantity).toBe(35);
    // (20*50 + 10*55) / 30 = 1550 / 30 = 51.666...
    expect(projection.averageKnownCost).toBeCloseTo(51.6667, 3);
  });

  it('flags the projection as partial when some units have unknown cost', () => {
    const events = [
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' }),
      addEvent({ quantity: 5, costPerUnit: null, recordedAt: '2026-08-07T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    expect(isCostProjectionPartial(projection)).toBe(true);
  });

  it('is not partial when every addition has a recorded cost', () => {
    const events = [
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    expect(isCostProjectionPartial(projection)).toBe(false);
  });
});

describe('calculateCostProjection — latest cost resolution', () => {
  it('determines "latest" by recordedAt, NOT by array position', () => {
    // Deliberately fed out of chronological order: the later-recorded
    // event appears FIRST in the array. If the implementation naively used
    // array order (e.g. "last item wins"), this test would fail.
    const events = [
      addEvent({ quantity: 10, costPerUnit: 60, recordedAt: '2026-08-09T09:00:00.000Z' }), // actually latest
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    expect(projection.latestCost).toBe(60);
  });

  it('is unaffected by purchaseDate — only recordedAt determines "latest"', () => {
    // A backdated purchase (purchaseDate far in the past) recorded most
    // recently should still be "latest," and a recently-dated purchase
    // entered earlier should not override it.
    const events = [
      addEvent({
        quantity: 10,
        costPerUnit: 70,
        purchaseDate: '2026-01-01', // old purchase date
        recordedAt: '2026-08-09T09:00:00.000Z' // but recorded most recently
      }),
      addEvent({
        quantity: 10,
        costPerUnit: 50,
        purchaseDate: '2026-08-08', // recent purchase date
        recordedAt: '2026-08-01T09:00:00.000Z' // but recorded earlier
      })
    ];
    const projection = calculateCostProjection(events);
    expect(projection.latestCost).toBe(70);
  });

  it('returns null latestCost when there are no cost-bearing additions', () => {
    const events = [addEvent({ quantity: 5, costPerUnit: null, recordedAt: '2026-08-01T09:00:00.000Z' })];
    const projection = calculateCostProjection(events);
    expect(projection.latestCost).toBeNull();
  });
});

describe('calculateCostProjection — exclusion rules', () => {
  it('ignores REMOVE events entirely', () => {
    const events = [
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' }),
      removeEvent({ quantity: 5, recordedAt: '2026-08-02T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    // totalQuantity reflects additions only, not net-of-removals — this
    // file computes cost, not current stock level (that's applyStockEvent.js).
    expect(projection.totalQuantity).toBe(20);
    expect(projection.knownCostQuantity).toBe(20);
    expect(projection.latestCost).toBe(50);
  });

  it('excludes unknown-cost units from averageKnownCost, does not treat them as ₹0', () => {
    const events = [
      addEvent({ quantity: 1, costPerUnit: 100, recordedAt: '2026-08-01T09:00:00.000Z' }),
      addEvent({ quantity: 1, costPerUnit: null, recordedAt: '2026-08-02T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    // If unknown cost were wrongly treated as 0, average would be 50, not 100.
    expect(projection.averageKnownCost).toBe(100);
    expect(projection.knownCostQuantity).toBe(1);
    expect(projection.totalQuantity).toBe(2);
  });

  it('excludes zero-quantity events from calculations', () => {
    const events = [
      addEvent({ quantity: 0, costPerUnit: 999, recordedAt: '2026-08-01T09:00:00.000Z' }),
      addEvent({ quantity: 10, costPerUnit: 50, recordedAt: '2026-08-02T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    expect(projection.latestCost).toBe(50);
    expect(projection.averageKnownCost).toBe(50);
  });

  it('treats costPerUnit of 0 as a genuinely recorded cost (e.g. a free sample), not "unknown"', () => {
    const events = [
      addEvent({ quantity: 5, costPerUnit: 0, recordedAt: '2026-08-01T09:00:00.000Z' })
    ];
    const projection = calculateCostProjection(events);
    expect(projection.knownCostQuantity).toBe(5);
    expect(projection.averageKnownCost).toBe(0);
    expect(projection.latestCost).toBe(0);
  });
});

describe('calculateCostProjection — empty/edge input', () => {
  it('returns nulls and zeros for an empty event list', () => {
    const projection = calculateCostProjection([]);
    expect(projection).toEqual({
      latestCost: null,
      averageKnownCost: null,
      knownCostQuantity: 0,
      totalQuantity: 0
    });
  });

  it('handles non-array input defensively rather than throwing', () => {
    const projection = calculateCostProjection(null);
    expect(projection.totalQuantity).toBe(0);
    expect(projection.latestCost).toBeNull();
  });

  it('does not mutate the input array or its events', () => {
    const events = [
      addEvent({ quantity: 20, costPerUnit: 50, recordedAt: '2026-08-01T09:00:00.000Z' })
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    calculateCostProjection(events);
    expect(events).toEqual(snapshot);
  });
});

describe('isCostProjectionPartial', () => {
  it('returns false for invalid/missing input rather than throwing', () => {
    expect(isCostProjectionPartial(null)).toBe(false);
    expect(isCostProjectionPartial(undefined)).toBe(false);
  });
});

describe('estimateCostForUnknownStock — PRD §18 (explicitly labelled estimate)', () => {
  it('uses latestCost as the estimate', () => {
    const projection = calculateCostProjection([
      addEvent({ quantity: 20, costPerUnit: 55, recordedAt: '2026-08-01T09:00:00.000Z' })
    ]);
    const estimate = estimateCostForUnknownStock(projection);
    expect(estimate.estimatedCostPerUnit).toBe(55);
  });

  it('always marks the result as an estimate', () => {
    const projection = calculateCostProjection([
      addEvent({ quantity: 20, costPerUnit: 55, recordedAt: '2026-08-01T09:00:00.000Z' })
    ]);
    const estimate = estimateCostForUnknownStock(projection);
    expect(estimate.isEstimate).toBe(true);
  });

  it('returns null estimatedCostPerUnit when there is no known cost at all', () => {
    const projection = calculateCostProjection([]);
    const estimate = estimateCostForUnknownStock(projection);
    expect(estimate.estimatedCostPerUnit).toBeNull();
    expect(estimate.isEstimate).toBe(true);
  });

  it('does not return a bare number — always the labelled shape, so callers cannot accidentally treat it as recorded fact', () => {
    const projection = calculateCostProjection([
      addEvent({ quantity: 1, costPerUnit: 10, recordedAt: '2026-08-01T09:00:00.000Z' })
    ]);
    const estimate = estimateCostForUnknownStock(projection);
    expect(typeof estimate).toBe('object');
    expect(estimate).toHaveProperty('isEstimate');
  });
});
