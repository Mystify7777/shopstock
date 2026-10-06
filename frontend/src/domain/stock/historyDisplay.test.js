import { describe, it, expect } from 'vitest';
import {
  orderHistoryNewestFirst,
  describeHistoryEntry,
  formatEntryTime,
  formatEntryDate
} from './historyDisplay.js';

const ev = (id, recordedAt, extra = {}) => ({ id, recordedAt, type: 'ADD', quantity: 1, ...extra });
const ids = (list) => list.map((e) => e.id);

describe('orderHistoryNewestFirst', () => {
  it('reverses a service-ordered (ascending) history', () => {
    const asc = [
      ev('a', '2026-09-01T10:00:00.000Z'),
      ev('b', '2026-09-02T10:00:00.000Z'),
      ev('c', '2026-09-03T10:00:00.000Z')
    ];
    expect(ids(orderHistoryNewestFirst(asc))).toEqual(['c', 'b', 'a']);
  });

  it('sorts by time even if the input is not already ascending', () => {
    const mixed = [ev('b', '2026-09-02T10:00:00.000Z'), ev('c', '2026-09-03T10:00:00.000Z'), ev('a', '2026-09-01T10:00:00.000Z')];
    expect(ids(orderHistoryNewestFirst(mixed))).toEqual(['c', 'b', 'a']);
  });

  it('keeps the service order for events with the same timestamp (no id tie-breaker)', () => {
    const t = '2026-09-01T10:00:00.000Z';
    // ids deliberately NOT alphabetical, so an id tie-break would be visible
    const sameInstant = [ev('z', t), ev('m', t), ev('a', t)];
    expect(ids(orderHistoryNewestFirst(sameInstant))).toEqual(['z', 'm', 'a']);
  });

  it('keeps service order inside a tie while still ordering across times', () => {
    const t1 = '2026-09-01T10:00:00.000Z';
    const t2 = '2026-09-02T10:00:00.000Z';
    const input = [ev('x', t1), ev('y', t1), ev('p', t2), ev('q', t2)];
    expect(ids(orderHistoryNewestFirst(input))).toEqual(['p', 'q', 'x', 'y']);
  });

  it('puts an event without a usable timestamp after the dated ones, keeping peers in order', () => {
    const input = [ev('n1', undefined), ev('d', '2026-09-01T10:00:00.000Z'), ev('n2', '')];
    expect(ids(orderHistoryNewestFirst(input))).toEqual(['d', 'n1', 'n2']);
  });

  it('keeps service order when no event has a timestamp', () => {
    expect(ids(orderHistoryNewestFirst([ev('1'), ev('2'), ev('3')]))).toEqual(['1', '2', '3']);
  });

  it('returns a new array and does not modify its input', () => {
    const input = [ev('a', '2026-09-01T10:00:00.000Z'), ev('b', '2026-09-02T10:00:00.000Z')];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = orderHistoryNewestFirst(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(out[0]).toBe(input[1]);
  });

  it('handles an empty history and rejects a non-array', () => {
    expect(orderHistoryNewestFirst([])).toEqual([]);
    expect(() => orderHistoryNewestFirst(null)).toThrow(TypeError);
  });
});

describe('describeHistoryEntry', () => {
  it('describes an ADD with its purchase date and cost', () => {
    expect(
      describeHistoryEntry({
        type: 'ADD',
        quantity: 20,
        appliedQuantity: 20,
        comment: 'New delivery',
        purchaseDate: '2026-09-01',
        costPerUnit: 55,
        recordedAt: '2026-09-02T10:00:00.000Z',
        reversalOf: null,
        reversedBy: null
      })
    ).toEqual({
      direction: 'added',
      amount: 20,
      requested: 20,
      wasClamped: false,
      comment: 'New delivery',
      isReversal: false,
      isReversed: false,
      recordedAt: '2026-09-02T10:00:00.000Z',
      purchaseDate: '2026-09-01',
      costPerUnit: 55
    });
  });

  it('reports an ADD with no cost as costPerUnit null (distinct from a removal, which has none)', () => {
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, costPerUnit: null }).costPerUnit).toBeNull();
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1 }).costPerUnit).toBeNull();
    expect(describeHistoryEntry({ type: 'REMOVE', quantity: 1 }).costPerUnit).toBeUndefined();
  });

  it('shows a clamped over-removal by what actually applied and says it was clamped', () => {
    const d = describeHistoryEntry({ type: 'REMOVE', quantity: 8, appliedQuantity: 5 });
    expect(d).toMatchObject({ direction: 'removed', amount: 5, requested: 8, wasClamped: true });
  });

  it('does not call a fully applied removal clamped', () => {
    expect(describeHistoryEntry({ type: 'REMOVE', quantity: 3, appliedQuantity: 3 }).wasClamped).toBe(false);
  });

  it('falls back to the requested quantity when appliedQuantity is absent', () => {
    const d = describeHistoryEntry({ type: 'REMOVE', quantity: 3 });
    expect(d.amount).toBe(3);
    expect(d.wasClamped).toBe(false);
  });

  it('turns an empty or whitespace comment into null (the page shows "No justification provided")', () => {
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, comment: '' }).comment).toBeNull();
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, comment: '   ' }).comment).toBeNull();
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, comment: null }).comment).toBeNull();
  });

  it('flags reversals and reversed originals from the real link fields', () => {
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, reversalOf: 'e0' }).isReversal).toBe(true);
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1, reversedBy: 'e2' }).isReversed).toBe(true);
    const plain = describeHistoryEntry({ type: 'ADD', quantity: 1, reversalOf: null, reversedBy: null });
    expect(plain.isReversal).toBe(false);
    expect(plain.isReversed).toBe(false);
  });

  it('nulls malformed or missing timestamps and purchase dates instead of throwing', () => {
    const d = describeHistoryEntry({ type: 'ADD', quantity: 1, recordedAt: 'nope', purchaseDate: '2026-02-31' });
    expect(d.recordedAt).toBeNull();
    expect(d.purchaseDate).toBeNull();
    expect(describeHistoryEntry({ type: 'ADD', quantity: 1 }).recordedAt).toBeNull();
  });

  it('does not report a purchase date for a removal', () => {
    expect(describeHistoryEntry({ type: 'REMOVE', quantity: 1, purchaseDate: '2026-09-01' }).purchaseDate).toBeNull();
  });
});

describe('formatEntryTime / formatEntryDate', () => {
  it('formats valid values', () => {
    expect(formatEntryDate('2026-08-09')).toBe('09 Aug 2026');
    expect(formatEntryTime('2026-08-09T09:42:31.123Z')).toMatch(/^\d{2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it.each([null, undefined, '', 'garbage', '2026-02-31'])('returns null (never throws) for %j', (bad) => {
    expect(formatEntryDate(bad)).toBeNull();
    expect(formatEntryTime(bad)).toBeNull();
  });
});
