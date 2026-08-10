import { describe, it, expect } from 'vitest';
import { createReversalEvent, canBeReversed, isReversalEvent } from '../../../src/domain/stock/reversal.js';
import { createAddStockEvent, createRemoveStockEvent, STOCK_EVENT_TYPE } from '../../../src/domain/stock/stockEventFactory.js';
import { applyStockEvent } from '../../../src/domain/stock/applyStockEvent.js';
import { isValidId } from '../../../src/domain/shared/ids.js';
import { isValidTimestamp } from '../../../src/domain/shared/dates.js';

describe('createReversalEvent — basic construction (unclamped cases: appliedQuantity === requested quantity)', () => {
  it('reverses an ADD with a REMOVE of the same quantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 20 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 20);
    expect(errors).toEqual([]);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.REMOVE);
    expect(reversalEvent.quantity).toBe(20);
  });

  it('reverses an unclamped REMOVE with an ADD of the same quantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 8);
    expect(errors).toEqual([]);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(reversalEvent.quantity).toBe(8);
  });

  it('links the reversal to the original via reversalOf', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(reversalEvent.reversalOf).toBe(original.id);
  });

  it('returns a patch that links the original to the reversal via reversedBy', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent, originalPatch } = createReversalEvent(original, 5);
    expect(originalPatch).toEqual({ reversedBy: reversalEvent.id });
  });

  it('the patch contains ONLY reversedBy — no other field of the original is touched', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5, costPerUnit: 50 }).event;
    const { originalPatch } = createReversalEvent(original, 5);
    expect(Object.keys(originalPatch)).toEqual(['reversedBy']);
  });

  it('gives the reversal event its own fresh, valid id', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(isValidId(reversalEvent.id)).toBe(true);
    expect(reversalEvent.id).not.toBe(original.id);
  });

  it('gives the reversal event its own fresh recordedAt', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(isValidTimestamp(reversalEvent.recordedAt)).toBe(true);
  });

  it('carries the same productId as the original', () => {
    const original = createAddStockEvent({ productId: 'product-xyz', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(reversalEvent.productId).toBe('product-xyz');
  });

  it('the reversal itself starts with reversedBy null (not yet reversed)', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(reversalEvent.reversedBy).toBeNull();
  });

  it('sets a descriptive comment identifying it as a reversal', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 3 }).event;
    const { reversalEvent } = createReversalEvent(original, 3);
    expect(reversalEvent.comment).toMatch(/reversal/i);
  });
});

describe('createReversalEvent — THE OVER-REMOVAL REVERSAL FIX: reverses the TRUE applied effect, not the requested quantity', () => {
  it('reversing a clamped over-removal (5 available, 8 requested, 5 actually applied) restores exactly 5, not 8', () => {
    const current = 5;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const applyResult = applyStockEvent(current, removeEvent);

    expect(applyResult.nextQuantity).toBe(0);
    expect(applyResult.appliedQuantity).toBe(5);

    const { reversalEvent, errors } = createReversalEvent(removeEvent, applyResult.appliedQuantity);
    expect(errors).toEqual([]);
    expect(reversalEvent.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(reversalEvent.quantity).toBe(5);
    expect(reversalEvent.quantity).not.toBe(removeEvent.quantity); // NOT 8
  });

  it('end-to-end: quantity 5 -> REMOVE 8 -> clamped 0 -> reverse -> back to exactly 5, not 8', () => {
    let quantity = 5;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;

    const applyResult = applyStockEvent(quantity, removeEvent);
    quantity = applyResult.nextQuantity;
    expect(quantity).toBe(0);

    const { reversalEvent } = createReversalEvent(removeEvent, applyResult.appliedQuantity);
    const reversalApplyResult = applyStockEvent(quantity, reversalEvent);
    quantity = reversalApplyResult.nextQuantity;

    expect(quantity).toBe(5);
  });

  it('the immediate-undo scenario from the bug report does not inflate inventory', () => {
    let quantity = 5;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const applyResult = applyStockEvent(quantity, removeEvent);
    quantity = applyResult.nextQuantity;

    const { reversalEvent } = createReversalEvent(removeEvent, applyResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;

    expect(quantity).toBe(5);
    expect(quantity).not.toBe(8);
  });

  it('when a REMOVE was NOT clamped, reversing it still restores the exact original quantity (regression guard)', () => {
    let quantity = 10;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 4 }).event;
    const applyResult = applyStockEvent(quantity, removeEvent);
    quantity = applyResult.nextQuantity;
    expect(quantity).toBe(6);
    expect(applyResult.appliedQuantity).toBe(4);

    const { reversalEvent } = createReversalEvent(removeEvent, applyResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;
    expect(quantity).toBe(10);
  });

  it('reversing an ADD always uses appliedQuantity === event.quantity (ADD is never clamped)', () => {
    let quantity = 10;
    const addEvent = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const applyResult = applyStockEvent(quantity, addEvent);
    quantity = applyResult.nextQuantity;
    expect(applyResult.appliedQuantity).toBe(5);

    const { reversalEvent } = createReversalEvent(addEvent, applyResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;
    expect(quantity).toBe(10);
  });
});

describe('createReversalEvent — a reversal of an ADD does not carry a fabricated cost/purchaseDate', () => {
  it('never invents a cost for the reversal, even if the original ADD had one', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: 55 }).event;
    const { reversalEvent } = createReversalEvent(original, 10);
    expect(reversalEvent.costPerUnit).toBeNull();
  });

  it('never invents a purchaseDate for a reversal of a REMOVE, even though its type is ADD', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 10 }).event;
    const { reversalEvent } = createReversalEvent(original, 10);
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

describe('createReversalEvent — required appliedQuantity parameter', () => {
  it('rejects a missing appliedQuantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent, errors } = createReversalEvent(original);
    expect(reversalEvent).toBeNull();
    expect(errors).toContain('The actual applied quantity for this event is required to reverse it.');
  });

  it('rejects a zero or negative appliedQuantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    expect(createReversalEvent(original, 0).errors.length).toBeGreaterThan(0);
    expect(createReversalEvent(original, -3).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric appliedQuantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { errors } = createReversalEvent(original, 'five');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('createReversalEvent — appliedQuantity upper-bound invariant (0 < appliedQuantity <= originalEvent.quantity)', () => {
  it('rejects an appliedQuantity greater than the original requested quantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 100);
    expect(reversalEvent).toBeNull();
    expect(errors).toContain(
      "The applied quantity cannot exceed the original event's requested quantity."
    );
  });

  it('rejects an appliedQuantity just barely greater than the requested quantity', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 8.0001);
    expect(reversalEvent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts an appliedQuantity exactly equal to the requested quantity (the ordinary, unclamped case)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 8);
    expect(errors).toEqual([]);
    expect(reversalEvent.quantity).toBe(8);
  });

  it('accepts an appliedQuantity less than the requested quantity (the clamped over-removal case)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent, errors } = createReversalEvent(original, 5);
    expect(errors).toEqual([]);
    expect(reversalEvent.quantity).toBe(5);
  });

  it('accepts a valid decimal appliedQuantity at or below a decimal requested quantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 2.5 }).event;
    expect(createReversalEvent(original, 2.5).errors).toEqual([]);
    expect(createReversalEvent(original, 1.25).errors).toEqual([]);
  });

  it('rejects a decimal appliedQuantity above a decimal requested quantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 2.5 }).event;
    const { errors } = createReversalEvent(original, 2.6);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('would have caught the vulnerability this check closes: a caller supplying an inflated appliedQuantity cannot manufacture an oversized reversal', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    // A buggy or malicious caller claiming "100 units were applied" when
    // the event only ever requested 8 must be rejected outright, not
    // silently produce a 100-unit reversal.
    const { reversalEvent, errors } = createReversalEvent(original, 100);
    expect(reversalEvent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('createReversalEvent — cannot reverse an already-reversed event', () => {
  it('rejects reversing an event whose reversedBy is already set', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { originalPatch } = createReversalEvent(original, 5);
    const patchedOriginal = { ...original, ...originalPatch };

    const secondAttempt = createReversalEvent(patchedOriginal, 5);
    expect(secondAttempt.reversalEvent).toBeNull();
    expect(secondAttempt.errors).toContain('This event has already been reversed.');
  });

  it('rejects reversing a malformed event', () => {
    const { reversalEvent, errors } = createReversalEvent({ type: 'ADJUST', quantity: 5 }, 5);
    expect(reversalEvent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects reversing null/undefined', () => {
    expect(createReversalEvent(null, 5).errors.length).toBeGreaterThan(0);
    expect(createReversalEvent(undefined, 5).errors.length).toBeGreaterThan(0);
  });

  it('rejects an event with zero/negative quantity', () => {
    const { errors } = createReversalEvent(
      { id: 'e1', type: 'ADD', quantity: 0, reversedBy: null },
      5
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('reversals are themselves reversible — second-order reversal', () => {
  it('a reversal event CAN itself be reversed (its own reversedBy starts null)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original, 8);

    expect(canBeReversed(firstReversal)).toBe(true);

    const second = createReversalEvent(firstReversal, firstReversal.quantity);
    expect(second.errors).toEqual([]);
    expect(second.reversalEvent).not.toBeNull();
  });

  it('the second-order reversal points back at the first reversal, not at the original', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original, 8);
    const { reversalEvent: secondReversal } = createReversalEvent(firstReversal, firstReversal.quantity);

    expect(secondReversal.reversalOf).toBe(firstReversal.id);
    expect(secondReversal.reversalOf).not.toBe(original.id);
  });

  it('the second-order reversal has the same type as the original (REMOVE -> ADD -> REMOVE)', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const { reversalEvent: firstReversal } = createReversalEvent(original, 8); // ADD
    const { reversalEvent: secondReversal } = createReversalEvent(firstReversal, firstReversal.quantity); // REMOVE

    expect(original.type).toBe(STOCK_EVENT_TYPE.REMOVE);
    expect(firstReversal.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(secondReversal.type).toBe(STOCK_EVENT_TYPE.REMOVE);
  });

  it('reference chain stays a simple singly-linked list, not a tangled graph', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent: firstReversal, originalPatch: patchA } = createReversalEvent(original, 5);
    const patchedOriginal = { ...original, ...patchA };

    const { reversalEvent: secondReversal, originalPatch: patchB } = createReversalEvent(
      firstReversal,
      firstReversal.quantity
    );
    const patchedFirstReversal = { ...firstReversal, ...patchB };

    expect(patchedOriginal.reversedBy).toBe(firstReversal.id);
    expect(patchedFirstReversal.reversalOf).toBe(original.id);
    expect(patchedFirstReversal.reversedBy).toBe(secondReversal.id);
    expect(secondReversal.reversalOf).toBe(firstReversal.id);
    expect(secondReversal.reversedBy).toBeNull();
  });

  it('cannot attach a second, competing reversal directly to an original that already has one', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { originalPatch } = createReversalEvent(original, 5);
    const patchedOriginal = { ...original, ...originalPatch };

    const competingAttempt = createReversalEvent(patchedOriginal, 5);
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
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(isReversalEvent(reversalEvent)).toBe(true);
  });

  it('is false for null/undefined', () => {
    expect(isReversalEvent(null)).toBe(false);
    expect(isReversalEvent(undefined)).toBe(false);
  });
});

describe('undo and historical reversal are the same operation — no separate code path', () => {
  it('calling createReversalEvent() immediately (simulating the 5s undo toast) behaves identically to calling it much later (simulating historical reversal), given the same appliedQuantity', () => {
    const original = createRemoveStockEvent({ productId: 'p1', quantity: 2, comment: 'Sold' }).event;

    const immediateResult = createReversalEvent(original, 2);
    const laterResult = createReversalEvent(original, 2);

    expect(immediateResult.reversalEvent.type).toBe(laterResult.reversalEvent.type);
    expect(immediateResult.reversalEvent.quantity).toBe(laterResult.reversalEvent.quantity);
    expect(immediateResult.reversalEvent.reversalOf).toBe(laterResult.reversalEvent.reversalOf);
  });

  it('there is no "isUndo" or similar flag anywhere on the produced event', () => {
    const original = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const { reversalEvent } = createReversalEvent(original, 5);
    expect(reversalEvent).not.toHaveProperty('isUndo');
    expect(reversalEvent).not.toHaveProperty('undoOf');
    expect(reversalEvent).not.toHaveProperty('source');
  });
});

describe('integration with applyStockEvent — a reversal actually undoes the quantity effect', () => {
  it('applying an ADD then its reversal returns quantity to the starting point', () => {
    let quantity = 10;
    const addEvent = createAddStockEvent({ productId: 'p1', quantity: 5 }).event;
    const addResult = applyStockEvent(quantity, addEvent);
    quantity = addResult.nextQuantity;
    expect(quantity).toBe(15);

    const { reversalEvent } = createReversalEvent(addEvent, addResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;
    expect(quantity).toBe(10);
  });

  it('applying a REMOVE then its reversal returns quantity to the starting point (non-clamped case)', () => {
    let quantity = 10;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 4 }).event;
    const removeResult = applyStockEvent(quantity, removeEvent);
    quantity = removeResult.nextQuantity;
    expect(quantity).toBe(6);

    const { reversalEvent } = createReversalEvent(removeEvent, removeResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;
    expect(quantity).toBe(10);
  });

  it('reversing a clamped over-removal restores exactly the pre-removal quantity (the fixed behavior)', () => {
    let quantity = 5;
    const removeEvent = createRemoveStockEvent({ productId: 'p1', quantity: 8 }).event;
    const removeResult = applyStockEvent(quantity, removeEvent);
    quantity = removeResult.nextQuantity;
    expect(quantity).toBe(0);

    const { reversalEvent } = createReversalEvent(removeEvent, removeResult.appliedQuantity);
    quantity = applyStockEvent(quantity, reversalEvent).nextQuantity;

    expect(quantity).toBe(5);
  });
});
