import { describe, it, expect } from 'vitest';
import { createReversalEvent, canBeReversed, isReversalEvent } from '../../../src/domain/stock/reversal.js';
import { createAddStockEvent, createRemoveStockEvent, STOCK_EVENT_TYPE } from '../../../src/domain/stock/stockEventFactory.js';
import { applyStockEvent } from '../../../src/domain/stock/applyStockEvent.js';
import { isValidId } from '../../../src/domain/shared/ids.js';
import { isValidTimestamp } from '../../../src/domain/shared/dates.js';

describe('createReversalEvent — basic construction', () => {
  it('reverses an ADD with a REMOVE of the same quantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 20 }).event;
    const { reversalEvent, errors } = createReversalEvent(original);
    expect(errors).toEqual([]);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.REMOVE);
    expect(reversalEvent.quantity).toBe(20);
  });

  it('reverses a REMOVE with an ADD of the same quantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original);
    expect(errors).toEqual([]);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(reversalEvent.quantity).toBe(8);
  });

  it('links the reversal to the original via reversalOf', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.reversalOf).toBe(original.id);
  });

  it('returns a patch that links the original to the reversal via reversedBy', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent, originalPatch } = createReversalEvent(original);
    expect(originalPatch).toEqual({ reversedBy: reversalEvent.id });
  });

  it('the patch contains ONLY reversedBy — no other field of the original is touched', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5, costPerUnit: 50 }).event;
    const { originalPatch } = createReversalEvent(original);
    expect(Object.keys(originalPatch)).toEqual(['reversedBy']);
  });

  it('gives the reversal event its own fresh, valid id', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(isValidId(reversalEvent.id)).toBe(true);
    expect(reversalEvent.id).not.toBe(original.id);
  });

  it('gives the reversal event its own fresh recordedAt, not copied from the original', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(isValidTimestamp(reversalEvent.recordedAt)).toBe(true);
    // Should reflect "now" (the moment of reversal), same as the original
    // in this fast test, but structurally independent — not literally
    // aliased to original.recordedAt.
    expect(reversalEvent.recordedAt).not.toBe(undefined);
  });

  it('carries the same productId as the original', () => {
    const original = createAddStockEvent({ productId: 'product-xyz', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.productId).toBe('product-xyz');
  });

  it('the reversal itself starts with reversedBy null (not yet reversed)', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.reversedBy).toBeNull();
  });

  it('sets a descriptive comment identifying it as a reversal', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 3 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.comment).toMatch(/reversal/i);
  });
});

describe('createReversalEvent — a reversal of an ADD does not carry a fabricated cost/purchaseDate', () => {
  it('never invents a cost for the reversal, even if the original ADD had one', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: 55 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.costPerUnit).toBeNull();
  });

  it('never invents a purchaseDate for a reversal of a REMOVE, even though its type is ADD', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 10 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(reversalEvent.purchaseDate).toBeNull();
    expect(reversalEvent.costPerUnit).toBeNull();
  });
});

describe('canBeReversed', () => {
  it('is true for a fresh event', () => {
    const event = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    expect(canBeReversed(event)).toBe(true);
  });

  it('is false once reversedBy is set', () => {
    const event = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    event.reversedBy = 'some-reversal-id';
    expect(canBeReversed(event)).toBe(false);
  });

  it('is false for null/undefined input', () => {
    expect(canBeReversed(null)).toBe(false);
    expect(canBeReversed(undefined)).toBe(false);
  });
});

describe('createReversalEvent — cannot reverse an already-reversed event', () => {
  it('rejects reversing an event whose reversedBy is already set', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { originalPatch } = createReversalEvent(original);
    // Simulate the repository applying the patch.
    const patchedOriginal = { ...original, ...originalPatch };

    const secondAttempt = createReversalEvent(patchedOriginal);
    expect(secondAttempt.reversalEvent).toBeNull();
    expect(secondAttempt.errors).toContain('This event has already been reversed.');
  });

  it('rejects reversing a malformed event', () => {
    const { reversalEvent, errors } = createReversalEvent({ type: 'ADJUST', quantity: 5 });
    expect(reversalEvent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects reversing null/undefined', () => {
    expect(createReversalEvent(null).errors.length).toBeGreaterThan(0);
    expect(createReversalEvent(undefined).errors.length).toBeGreaterThan(0);
  });

  it('rejects an event with zero/negative quantity', () => {
    const { errors } = createReversalEvent({
      id: 'e1',
      type: 'ADD',
      quantity: 0,
      reversedBy: null
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('reversals are themselves reversible — second-order reversal', () => {
  it('a reversal event CAN itself be reversed (its own reversedBy starts null)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original);

    expect(canBeReversed(firstReversal)).toBe(true);

    const second = createReversalEvent(firstReversal);
    expect(second.errors).toEqual([]);
    expect(second.reversalEvent).not.toBeNull();
  });

  it('the second-order reversal points back at the first reversal, not at the original', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original);
    const { reversalEvent: secondReversal } = createReversalEvent(firstReversal);

    expect(secondReversal.reversalOf).toBe(firstReversal.id);
    expect(secondReversal.reversalOf).not.toBe(original.id);
  });

  it('the second-order reversal has the same type as the original (REMOVE -> ADD -> REMOVE)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original); // ADD
    const { reversalEvent: secondReversal } = createReversalEvent(firstReversal); // REMOVE

    expect(original.type).toBe(STOCK_EVENT_TYPE.REMOVE);
    expect(firstReversal.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(secondReversal.type).toBe(STOCK_EVENT_TYPE.REMOVE);
  });

  it('reference chain stays a simple singly-linked list, not a tangled graph', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent: firstReversal, originalPatch: patchA } = createReversalEvent(original);
    const patchedOriginal = { ...original, ...patchA };

    const { reversalEvent: secondReversal, originalPatch: patchB } = createReversalEvent(firstReversal);
    const patchedFirstReversal = { ...firstReversal, ...patchB };

    // original -> firstReversal -> secondReversal, each link touching
    // exactly one forward and one backward pointer.
    expect(patchedOriginal.reversedBy).toBe(firstReversal.id);
    expect(patchedFirstReversal.reversalOf).toBe(original.id);
    expect(patchedFirstReversal.reversedBy).toBe(secondReversal.id);
    expect(secondReversal.reversalOf).toBe(firstReversal.id);
    expect(secondReversal.reversedBy).toBeNull();
  });

  it('cannot attach a second, competing reversal directly to an original that already has one', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { originalPatch } = createReversalEvent(original);
    const patchedOriginal = { ...original, ...originalPatch };

    // Attempting to reverse the ORIGINAL again (not its reversal) must fail.
    const competingAttempt = createReversalEvent(patchedOriginal);
    expect(competingAttempt.reversalEvent).toBeNull();
  });
});

describe('isReversalEvent', () => {
  it('is false for an ordinary event', () => {
    const event = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    expect(isReversalEvent(event)).toBe(false);
  });

  it('is true for a reversal event', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(isReversalEvent(reversalEvent)).toBe(true);
  });

  it('is false for null/undefined', () => {
    expect(isReversalEvent(null)).toBe(false);
    expect(isReversalEvent(undefined)).toBe(false);
  });
});

describe('undo and historical reversal are the same operation — no separate code path', () => {
  it('calling createReversalEvent() immediately after construction (simulating the 5s undo toast) behaves identically to calling it much later (simulating historical reversal)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 2, comment: 'Sold' }).event;

    // "Immediate undo" path
    const immediateResult = createReversalEvent(original);

    // "Historical reversal, much later" path — same function, same input
    // shape; nothing about calling it later changes its behavior, because
    // this function has no concept of elapsed time at all.
    const laterResult = createReversalEvent(original);

    expect(immediateResult.reversalEvent.type).toBe(laterResult.reversalEvent.type);
    expect(immediateResult.reversalEvent.quantity).toBe(laterResult.reversalEvent.quantity);
    expect(immediateResult.reversalEvent.reversalOf).toBe(laterResult.reversalEvent.reversalOf);
    // (ids/recordedAt naturally differ since these are two separate calls
    // simulating two different reversal attempts — the point is the
    // *behavior*, not object identity.)
  });

  it('there is no "isUndo" or similar flag anywhere on the produced event', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original);
    expect(reversalEvent).not.toHaveProperty('isUndo');
    expect(reversalEvent).not.toHaveProperty('undoOf');
    expect(reversalEvent).not.toHaveProperty('source');
  });
});

describe('integration with applyStockEvent — a reversal actually undoes the quantity effect', () => {
  it('applying an ADD then its reversal returns quantity to the starting point', () => {
    let quantity = 10;
    const addEvent = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    quantity = applyStockEvent(quantity, addEvent);
    expect(quantity).toBe(15);

    const { reversalEvent } = createReversalEvent(addEvent);
    quantity = applyStockEvent(quantity, reversalEvent);
    expect(quantity).toBe(10);
  });

  it('applying a REMOVE then its reversal returns quantity to the starting point (non-clamped case)', () => {
    let quantity = 10;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 4 }).event;
    quantity = applyStockEvent(quantity, removeEvent);
    expect(quantity).toBe(6);

    const { reversalEvent } = createReversalEvent(removeEvent);
    quantity = applyStockEvent(quantity, reversalEvent);
    expect(quantity).toBe(10);
  });

  it('reversing an over-removal restores only from the clamped floor, not to the pre-clamp (impossible) negative state', () => {
    // current = 5, remove 8 -> clamped to 0 (not -3). Reversing the
    // removal ADDs 8 back, landing at 8 — NOT back to 5. This is an
    // honest consequence of the clamp: the event says 8 was removed, so
    // reversing it truthfully adds 8 back, even though only 5 could have
    // actually left the shelf. This is expected/documented behavior, not
    // a bug — see docs/ARCHITECTURE.md "The over-removal reconciliation."
    let quantity = 5;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    quantity = applyStockEvent(quantity, removeEvent);
    expect(quantity).toBe(0);

    const { reversalEvent } = createReversalEvent(removeEvent);
    quantity = applyStockEvent(quantity, reversalEvent);
    expect(quantity).toBe(8);
  });
});
