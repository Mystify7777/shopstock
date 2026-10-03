import { describe, it, expect } from 'vitest';
import { sortProductsByName } from './productOrdering.js';

const p = (id, name) => ({ id, name });
const ids = (list) => list.map((x) => x.id);

describe('sortProductsByName', () => {
  it('sorts by name ascending', () => {
    expect(ids(sortProductsByName([p('1', 'Zeta'), p('2', 'Alpha'), p('3', 'Mango')]))).toEqual(['2', '3', '1']);
  });

  it('is case-insensitive', () => {
    expect(ids(sortProductsByName([p('1', 'banana'), p('2', 'Apple'), p('3', 'cherry'), p('4', 'Banana2')]))).toEqual([
      '2',
      '1',
      '4',
      '3'
    ]);
  });

  it('ignores surrounding whitespace in names', () => {
    expect(ids(sortProductsByName([p('1', '  Beta'), p('2', 'Alpha  ')]))).toEqual(['2', '1']);
  });

  it('puts unnamed products (null, empty, whitespace-only, missing) last', () => {
    const result = sortProductsByName([
      p('a', null),
      p('b', 'Zebra'),
      p('c', ''),
      p('d', '   '),
      p('e', 'Apple'),
      { id: 'f' }
    ]);
    expect(ids(result).slice(0, 2)).toEqual(['e', 'b']);
    expect(new Set(ids(result).slice(2))).toEqual(new Set(['a', 'c', 'd', 'f']));
  });

  it('orders unnamed products among themselves by id', () => {
    expect(ids(sortProductsByName([p('c', null), p('a', ''), p('b', '  ')]))).toEqual(['a', 'b', 'c']);
  });

  it('breaks name ties (including case-only differences) by id', () => {
    expect(ids(sortProductsByName([p('2', 'Same'), p('1', 'same'), p('3', 'SAME')]))).toEqual(['1', '2', '3']);
  });

  it('gives the same result whatever order the input arrives in', () => {
    const items = [p('4', 'delta'), p('1', 'Alpha'), p('3', 'Charlie'), p('2', 'alpha'), p('5', null)];
    const forward = ids(sortProductsByName(items));
    expect(ids(sortProductsByName([...items].reverse()))).toEqual(forward);
    expect(ids(sortProductsByName([items[2], items[4], items[0], items[3], items[1]]))).toEqual(forward);
  });

  it('returns a new array and does not mutate the input or its products', () => {
    const input = [p('2', 'B'), p('1', 'A')];
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = sortProductsByName(input);
    expect(result).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(result[0]).toBe(input[1]); // same product objects, not copies
  });

  it('handles empty and single-item lists', () => {
    expect(sortProductsByName([])).toEqual([]);
    const only = p('1', 'Solo');
    expect(sortProductsByName([only])).toEqual([only]);
  });

  it.each([null, undefined, 'abc', 5, {}])('rejects a non-array (%s)', (bad) => {
    expect(() => sortProductsByName(bad)).toThrow(TypeError);
  });
});
