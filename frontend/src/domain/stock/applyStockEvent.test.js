import { describe, it, expect } from 'vitest';
import { applyStockEvent, wouldOverRemove } from '../../../src/domain/stock/applyStockEvent.js';
import { createAddStockEvent, createRemoveStockEvent } from '../../../src/domain/stock/stockEventFactory.js';

describe('applyStockEvent — ADD', () => {
  it('adds the event quantity to the current quantity', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 20 });
    expect(applyStockEvent(10, event)).toBe(30);
  });

  it('adds to a zero starting quantity', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(applyStockEvent(0, event)).toBe(5);
  });

  it('handles decimal quantities correctly', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 2.5 });
    expect(applyStockEvent(1.5, event)).toBeCloseTo(4, 6);
  });
});

describe('applyStockEvent — REMOVE, ordinary (non-over-removal) case', () => {
  it('subtracts the event quantity from the current quantity', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 3 });
    expect(applyStockEvent(10, event)).toBe(7);
  });

  it('removing exactly the full available quantity results in exactly 0', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 10 });
    expect(applyStockEvent(10, event)).toBe(0);
  });

  it('handles decimal quantities correctly', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 1.5 });
    expect(applyStockEvent(3.5, event)).toBeCloseTo(2, 6);
  });
});

describe('applyStockEvent — REMOVE, over-removal reconciliation', () => {
  it('clamps the materialized result at 0 rather than going negative', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 8 });
    // current = 5, remove = 8 -> would be -3 unclamped, must be 0
    expect(applyStockEvent(5, event)).toBe(0);
  });

  it('does not mutate the event to reflect the clamped amount', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 8 });
    applyStockEvent(5, event);
    // The event must still say 8 was removed — the full requested amount,
    // not "5, because that's all there was."
    expect(event.quantity).toBe(8);
  });

  it('does not throw on an over-removal — the operation is allowed to proceed', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 100 });
    expect(() => applyStockEvent(1, event)).not.toThrow();
  });

  it('clamps a wildly over-sized removal the same way as a small over-removal', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 100000 });
    expect(applyStockEvent(3, event)).toBe(0);
  });

  it('the returned quantity is never negative for any current/removal combination', () => {
    const combos = [
      [0, 1],
      [1, 1],
      [1, 2],
      [5, 8],
      [0.5, 1],
      [2.5, 10]
    ];
    for (const [current, removeQty] of combos) {
      const { event } = createRemoveStockEvent({ productId: 'p1', quantity: removeQty });
      const result = applyStockEvent(current, event);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('applyStockEvent — validation / guards', () => {
  it('throws on a non-finite currentQuantity', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(() => applyStockEvent(NaN, event)).toThrow(TypeError);
    expect(() => applyStockEvent(Infinity, event)).toThrow(TypeError);
    expect(() => applyStockEvent(undefined, event)).toThrow(TypeError);
  });

  it('throws on a negative currentQuantity (should never happen upstream, but must fail loudly if it does)', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(() => applyStockEvent(-1, event)).toThrow(TypeError);
  });

  it('throws on a missing event', () => {
    expect(() => applyStockEvent(10, null)).toThrow(TypeError);
    expect(() => applyStockEvent(10, undefined)).toThrow(TypeError);
  });

  it('throws on an event with an unrecognized type', () => {
    expect(() => applyStockEvent(10, { type: 'ADJUST', quantity: 5 })).toThrow(TypeError);
  });

  it('throws on an event with a zero or negative quantity', () => {
    expect(() => applyStockEvent(10, { type: 'ADD', quantity: 0 })).toThrow(TypeError);
    expect(() => applyStockEvent(10, { type: 'ADD', quantity: -5 })).toThrow(TypeError);
  });

  it('throws on an event with a non-numeric quantity', () => {
    expect(() => applyStockEvent(10, { type: 'ADD', quantity: 'five' })).toThrow(TypeError);
  });
});

describe('wouldOverRemove', () => {
  it('is true when removing more than currently available', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 8 });
    expect(wouldOverRemove(5, event)).toBe(true);
  });

  it('is false when removing exactly the available quantity', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 5 });
    expect(wouldOverRemove(5, event)).toBe(false);
  });

  it('is false when removing less than the available quantity', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 3 });
    expect(wouldOverRemove(5, event)).toBe(false);
  });

  it('is always false for ADD events, regardless of quantity', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 999 });
    expect(wouldOverRemove(5, event)).toBe(false);
  });

  it('returns false defensively for malformed input rather than throwing', () => {
    expect(wouldOverRemove(NaN, { type: 'REMOVE', quantity: 5 })).toBe(false);
    expect(wouldOverRemove(5, null)).toBe(false);
    expect(wouldOverRemove(5, { type: 'REMOVE', quantity: 'five' })).toBe(false);
  });
});

describe('applyStockEvent + wouldOverRemove — used together as intended by the UI/service layer', () => {
  it('demonstrates the intended flow: check the warning first, then apply regardless of the answer', () => {
    const current = 5;
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 8, comment: 'Bulk sale' });

    const shouldWarn = wouldOverRemove(current, event);
    expect(shouldWarn).toBe(true);

    // User confirms anyway (PRD §12: "Continue" option) — apply proceeds
    // and clamps, it does not re-check or block based on the warning.
    const next = applyStockEvent(current, event);
    expect(next).toBe(0);

    // The event remains the full, honest record.
    expect(event.quantity).toBe(8);
  });
});
