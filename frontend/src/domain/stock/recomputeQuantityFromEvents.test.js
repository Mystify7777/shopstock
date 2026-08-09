import { describe, it, expect } from 'vitest';
import { recomputeQuantityFromEvents } from '../../../src/domain/stock/recomputeQuantityFromEvents.js';
import { createAddStockEvent, createRemoveStockEvent } from '../../../src/domain/stock/stockEventFactory.js';

function add(quantity) {
  return createAddStockEvent({ productId: 'p1', quantity }).event;
}

function remove(quantity) {
  return createRemoveStockEvent({ productId: 'p1', quantity }).event;
}

describe('recomputeQuantityFromEvents — basic cases', () => {
  it('returns 0 for an empty event list', () => {
    expect(recomputeQuantityFromEvents([])).toBe(0);
  });

  it('returns 0 for missing/non-array input rather than throwing', () => {
    expect(recomputeQuantityFromEvents(null)).toBe(0);
    expect(recomputeQuantityFromEvents(undefined)).toBe(0);
  });

  it('accumulates a pure ADD sequence', () => {
    const events = [add(5), add(10), add(3)];
    expect(recomputeQuantityFromEvents(events)).toBe(18);
  });

  it('accumulates a pure REMOVE sequence starting from 0 (clamped throughout)', () => {
    const events = [remove(1), remove(1)];
    // Starts at 0, remove 1 -> clamped 0, remove 1 -> clamped 0.
    expect(recomputeQuantityFromEvents(events)).toBe(0);
  });

  it('handles decimal quantities correctly across a mixed sequence', () => {
    const events = [add(2.5), add(1.25), remove(0.75)];
    expect(recomputeQuantityFromEvents(events)).toBeCloseTo(3, 6);
  });

  it('results in exactly 0 when a REMOVE exactly matches accumulated ADDs', () => {
    const events = [add(10), remove(10)];
    expect(recomputeQuantityFromEvents(events)).toBe(0);
  });

  it('clamps an over-removal to 0 mid-sequence', () => {
    const events = [add(5), remove(8)];
    expect(recomputeQuantityFromEvents(events)).toBe(0);
  });

  it('a subsequent ADD after an over-removal clamp starts from the clamped zero, not a negative carry-over', () => {
    const events = [add(5), remove(8), add(10)];
    // 5 -> (clamped) 0 -> 10. If clamping leaked a "-3" forward, this
    // would incorrectly be 7 instead of 10.
    expect(recomputeQuantityFromEvents(events)).toBe(10);
  });

  it('mixed ADD/REMOVE sequence without any clamping produces the plain arithmetic result', () => {
    const events = [add(20), remove(5), add(3), remove(2)];
    expect(recomputeQuantityFromEvents(events)).toBe(16);
  });
});

describe('recomputeQuantityFromEvents — order sensitivity', () => {
  it('ADD 5, REMOVE 8, ADD 10 -> 10 (clamp happens before the second ADD)', () => {
    const events = [add(5), remove(8), add(10)];
    expect(recomputeQuantityFromEvents(events)).toBe(10);
  });

  it('ADD 10, ADD 5, REMOVE 8 -> 7 (no clamping occurs in this order)', () => {
    const events = [add(10), add(5), remove(8)];
    expect(recomputeQuantityFromEvents(events)).toBe(7);
  });

  it('proves the same three events in different orders produce different results — order is never normalized/sorted away', () => {
    const a = add(5);
    const b = remove(8);
    const c = add(10);

    const orderOne = recomputeQuantityFromEvents([a, b, c]);
    const orderTwo = recomputeQuantityFromEvents([c, a, b]); // ADD 10, ADD 5, REMOVE 8

    expect(orderOne).toBe(10);
    expect(orderTwo).toBe(7);
    expect(orderOne).not.toBe(orderTwo);
  });

  it('does not sort events by recordedAt even when supplied out of chronological order', () => {
    // Two events where recordedAt order and array order deliberately
    // disagree. If this function silently sorted by recordedAt, the
    // result would differ from a plain array-order reduction.
    const earlyAdd = add(5); // recordedAt ~now
    const laterRemove = remove(8); // recordedAt ~now, slightly after

    // laterRemove has a later recordedAt but is placed FIRST in the array.
    const events = [laterRemove, earlyAdd];
    // Plain array-order reduction: 0 -> remove 8 (clamped 0) -> add 5 -> 5
    expect(recomputeQuantityFromEvents(events)).toBe(5);
  });
});

describe('recomputeQuantityFromEvents — starts from 0, not from a supplied current quantity', () => {
  it('takes only an events array — there is no parameter for an initial/current quantity', () => {
    // Structural check: calling with a bare events array is the entire
    // API. This test exists to make the "always starts from 0" contract
    // explicit and to fail loudly if a future edit adds a second
    // parameter that could reintroduce corrupted-quantity contamination.
    expect(recomputeQuantityFromEvents.length).toBe(1);
  });

  it('replay of the same events is always identical regardless of how many times it has been called before', () => {
    const events = [add(5), remove(2)];
    const first = recomputeQuantityFromEvents(events);
    const second = recomputeQuantityFromEvents(events);
    expect(first).toBe(second);
    expect(first).toBe(3);
  });
});

describe('recomputeQuantityFromEvents — immutability', () => {
  it('does not mutate individual events', () => {
    const events = [add(5), remove(8), add(10)];
    const snapshot = JSON.parse(JSON.stringify(events));
    recomputeQuantityFromEvents(events);
    expect(events).toEqual(snapshot);
  });

  it('does not mutate or reorder the input array', () => {
    const events = [add(5), remove(8), add(10)];
    const originalOrder = events.map((e) => e.id);
    recomputeQuantityFromEvents(events);
    expect(events.map((e) => e.id)).toEqual(originalOrder);
    expect(events.length).toBe(3);
  });
});

describe('recomputeQuantityFromEvents — error propagation', () => {
  it('propagates a TypeError from applyStockEvent for a malformed event, rather than skipping it silently', () => {
    const events = [add(5), { type: 'ADJUST', quantity: 3 }];
    expect(() => recomputeQuantityFromEvents(events)).toThrow(TypeError);
  });

  it('propagates a TypeError for a non-positive quantity found mid-list', () => {
    const events = [add(5), { type: 'ADD', quantity: 0 }];
    expect(() => recomputeQuantityFromEvents(events)).toThrow(TypeError);
  });
});

describe('recomputeQuantityFromEvents — does not special-case reversal fields', () => {
  it('treats a reversal-linked event as an ordinary ADD/REMOVE, applying it in array position with no special logic', () => {
    const original = remove(8);
    const reversal = add(8);
    reversal.reversalOf = original.id;
    original.reversedBy = reversal.id;

    const events = [add(10), original, reversal];
    // Plain reduction, ignoring the reversal linkage entirely:
    // 0 -> add 10 -> 10 -> remove 8 -> 2 -> add 8 (reversal) -> 10
    expect(recomputeQuantityFromEvents(events)).toBe(10);
  });
});
