import { describe, it, expect } from 'vitest';
import {
  createAddStockEvent,
  createRemoveStockEvent,
  isValidStockEventShape,
  STOCK_EVENT_TYPE
} from '../../../src/domain/stock/stockEventFactory.js';
import { isValidId } from '../../../src/domain/shared/ids.js';
import { isValidTimestamp, isValidDateOnly, todayDateOnly } from '../../../src/domain/shared/dates.js';

describe('createAddStockEvent — basic construction', () => {
  it('builds a valid ADD event with quantity and cost', () => {
    const { event, errors } = createAddStockEvent({
      productId: 'product-1',
      quantity: 20,
      costPerUnit: 50
    });
    expect(errors).toEqual([]);
    expect(event.type).toBe(STOCK_EVENT_TYPE.ADD);
    expect(event.quantity).toBe(20);
    expect(event.costPerUnit).toBe(50);
  });

  it('gives every event a valid, unique id', () => {
    const a = createAddStockEvent({ productId: 'p1', quantity: 1 }).event;
    const b = createAddStockEvent({ productId: 'p1', quantity: 1 }).event;
    expect(isValidId(a.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects zero quantity', () => {
    const { errors } = createAddStockEvent({ productId: 'p1', quantity: 0 });
    expect(errors).toContain('Quantity must be greater than 0.');
  });

  it('rejects negative quantity', () => {
    const { errors } = createAddStockEvent({ productId: 'p1', quantity: -5 });
    expect(errors).toContain('Quantity must be greater than 0.');
  });

  it('accepts decimal quantity (PRD §6)', () => {
    const { errors, event } = createAddStockEvent({ productId: 'p1', quantity: 2.5 });
    expect(errors).toEqual([]);
    expect(event.quantity).toBe(2.5);
  });

  it('rejects a missing productId', () => {
    const { errors } = createAddStockEvent({ quantity: 5 });
    expect(errors).toContain('A stock addition must be linked to a product.');
  });

  it('sets reversalOf and reversedBy to null on a fresh event', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(event.reversalOf).toBeNull();
    expect(event.reversedBy).toBeNull();
  });
});

describe('createAddStockEvent — cost is a prefill suggestion, not factory logic', () => {
  it('records exactly the cost given, and does not look anything up', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: 42 });
    expect(event.costPerUnit).toBe(42);
  });

  it('records costPerUnit as null when omitted (no cost recorded)', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 10 });
    expect(event.costPerUnit).toBeNull();
  });

  it('records costPerUnit as null when explicitly null (deliberately cleared, PRD §11.1)', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: null });
    expect(event.costPerUnit).toBeNull();
  });

  it('treats a costPerUnit of 0 as a real recorded cost, not "no cost"', () => {
    const { event, errors } = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: 0 });
    expect(errors).toEqual([]);
    expect(event.costPerUnit).toBe(0);
  });

  it('rejects a negative cost', () => {
    const { errors } = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: -5 });
    expect(errors).toContain('Cost per unit must be a non-negative number, or left blank.');
  });

  it('rejects a non-numeric cost', () => {
    const { errors } = createAddStockEvent({ productId: 'p1', quantity: 10, costPerUnit: 'fifty' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('createAddStockEvent — purchaseDate vs recordedAt (the load-bearing rule)', () => {
  it('defaults purchaseDate to today when omitted (PRD §11.2)', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 10 });
    expect(event.purchaseDate).toBe(todayDateOnly());
  });

  it('accepts an explicit, editable purchaseDate (can be backdated)', () => {
    const { event, errors } = createAddStockEvent({
      productId: 'p1',
      quantity: 10,
      purchaseDate: '2026-01-15'
    });
    expect(errors).toEqual([]);
    expect(event.purchaseDate).toBe('2026-01-15');
  });

  it('rejects an invalid purchaseDate string', () => {
    const { errors } = createAddStockEvent({
      productId: 'p1',
      quantity: 10,
      purchaseDate: '2026-02-30'
    });
    expect(errors).toContain('Purchase date is not a valid date.');
  });

  it('always generates a fresh, valid recordedAt timestamp', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 10 });
    expect(isValidTimestamp(event.recordedAt)).toBe(true);
  });

  it('IGNORES any caller-supplied recordedAt — recordedAt is never trusted from input', () => {
    // This is the load-bearing rule: a caller attempting to inject a fake
    // recordedAt (e.g. to backdate when something was "entered") must not
    // succeed, because costCalculations.js's "latest known cost" already
    // depends on recordedAt being trustworthy.
    const fakeRecordedAt = '2000-01-01T00:00:00.000Z';
    const { event } = createAddStockEvent({
      productId: 'p1',
      quantity: 10,
      recordedAt: fakeRecordedAt // not a documented parameter — attempted injection
    });
    expect(event.recordedAt).not.toBe(fakeRecordedAt);
    expect(isValidTimestamp(event.recordedAt)).toBe(true);
    // Should be "now", i.e. very close to actual current time.
    const recordedTime = new Date(event.recordedAt).getTime();
    expect(Math.abs(Date.now() - recordedTime)).toBeLessThan(5000);
  });

  it('keeps purchaseDate and recordedAt as genuinely different values for a backdated entry', () => {
    const { event } = createAddStockEvent({
      productId: 'p1',
      quantity: 10,
      purchaseDate: '2020-06-15'
    });
    expect(event.purchaseDate).toBe('2020-06-15');
    expect(isValidDateOnly(event.purchaseDate)).toBe(true);
    expect(isValidTimestamp(event.recordedAt)).toBe(true);
    // recordedAt should reflect "now" (2020s purchase, but entered today).
    expect(event.recordedAt.startsWith('2020')).toBe(false);
  });

  it('accepts an explicit null purchaseDate for callers with a specific reason to omit it', () => {
    const { event, errors } = createAddStockEvent({
      productId: 'p1',
      quantity: 10,
      purchaseDate: null
    });
    expect(errors).toEqual([]);
    expect(event.purchaseDate).toBeNull();
  });
});

describe('createAddStockEvent — comment normalization', () => {
  it('trims a comment', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5, comment: '  New delivery  ' });
    expect(event.comment).toBe('New delivery');
  });

  it('converts an omitted comment to null (not empty string) — "No justification" is display text, not stored input', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(event.comment).toBeNull();
  });

  it('converts an empty-string comment to null', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5, comment: '' });
    expect(event.comment).toBeNull();
  });

  it('converts a whitespace-only comment to null, same as empty', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5, comment: '   ' });
    expect(event.comment).toBeNull();
  });

  it('never stores the literal phrase "No justification provided" as if the user typed it', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(event.comment).not.toBe('No justification provided');
    expect(event.comment).toBeNull();
  });
});

describe('createRemoveStockEvent', () => {
  it('builds a valid REMOVE event', () => {
    const { event, errors } = createRemoveStockEvent({ productId: 'p1', quantity: 3, comment: 'Sold' });
    expect(errors).toEqual([]);
    expect(event.type).toBe(STOCK_EVENT_TYPE.REMOVE);
    expect(event.quantity).toBe(3);
    expect(event.comment).toBe('Sold');
  });

  it('never carries a cost, even if the caller tries to sneak one in', () => {
    const { event } = createRemoveStockEvent({
      productId: 'p1',
      quantity: 3,
      costPerUnit: 999 // not a real parameter — should be silently absent from output
    });
    expect(event.costPerUnit).toBeNull();
  });

  it('never carries a purchaseDate, even if the caller tries to sneak one in', () => {
    const { event } = createRemoveStockEvent({
      productId: 'p1',
      quantity: 3,
      purchaseDate: '2026-01-01' // not a real parameter — should be silently absent from output
    });
    expect(event.purchaseDate).toBeNull();
  });

  it('does NOT reject or warn about removing more than "available" — that is a caller/UI concern (PRD §12)', () => {
    // This factory has no concept of current stock level, so it must not
    // attempt to enforce or even acknowledge an over-removal check.
    const { errors } = createRemoveStockEvent({ productId: 'p1', quantity: 100000 });
    expect(errors).toEqual([]);
  });

  it('rejects zero or negative quantity, same as ADD', () => {
    expect(createRemoveStockEvent({ productId: 'p1', quantity: 0 }).errors.length).toBeGreaterThan(0);
    expect(createRemoveStockEvent({ productId: 'p1', quantity: -1 }).errors.length).toBeGreaterThan(0);
  });

  it('normalizes an empty comment to null, same as ADD', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 3, comment: '' });
    expect(event.comment).toBeNull();
  });

  it('generates its own recordedAt, ignoring any caller-supplied value', () => {
    const { event } = createRemoveStockEvent({
      productId: 'p1',
      quantity: 3,
      recordedAt: '2000-01-01T00:00:00.000Z'
    });
    expect(event.recordedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(isValidTimestamp(event.recordedAt)).toBe(true);
  });

  it('sets reversalOf and reversedBy to null on a fresh event', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 3 });
    expect(event.reversalOf).toBeNull();
    expect(event.reversedBy).toBeNull();
  });
});

describe('isValidStockEventShape', () => {
  it('accepts a well-formed ADD event', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(isValidStockEventShape(event)).toBe(true);
  });

  it('accepts a well-formed REMOVE event', () => {
    const { event } = createRemoveStockEvent({ productId: 'p1', quantity: 5 });
    expect(isValidStockEventShape(event)).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(
      isValidStockEventShape({ type: 'ADJUST', quantity: 5, recordedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
  });

  it('rejects zero/negative/missing quantity', () => {
    expect(
      isValidStockEventShape({ type: 'ADD', quantity: 0, recordedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
    expect(
      isValidStockEventShape({ type: 'ADD', recordedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
  });

  it('rejects a missing recordedAt', () => {
    expect(isValidStockEventShape({ type: 'ADD', quantity: 5 })).toBe(false);
  });

  it('rejects null/undefined/non-object input', () => {
    expect(isValidStockEventShape(null)).toBe(false);
    expect(isValidStockEventShape(undefined)).toBe(false);
    expect(isValidStockEventShape('event')).toBe(false);
  });
});

describe('this factory never touches Product.quantity', () => {
  it('the returned event has no "product" or "newQuantity"-shaped field at all', () => {
    const { event } = createAddStockEvent({ productId: 'p1', quantity: 5 });
    expect(event).not.toHaveProperty('newQuantity');
    expect(event).not.toHaveProperty('product');
    expect(event).not.toHaveProperty('resultingQuantity');
  });
});
