import { describe, it, expect } from 'vitest';
import { generateId, isValidId } from '../../../src/domain/shared/ids.js';

describe('generateId', () => {
  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns a valid UUID v4 shape', () => {
    const id = generateId();
    // Standard UUID v4 pattern: 8-4-4-4-12 hex digits, version nibble '4',
    // variant nibble in {8,9,a,b}.
    const uuidV4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidV4Pattern);
  });

  it('generates unique ids across many calls', () => {
    const ids = new Set();
    const count = 10000;
    for (let i = 0; i < count; i++) {
      ids.add(generateId());
    }
    // If generateId collided, the set would be smaller than `count`.
    expect(ids.size).toBe(count);
  });
});

describe('isValidId', () => {
  it('accepts a freshly generated id', () => {
    expect(isValidId(generateId())).toBe(true);
  });

  it('accepts a deterministic test-style id (not strict UUID format)', () => {
    expect(isValidId('test-product-1')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidId('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isValidId('   ')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidId(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidId(12345)).toBe(false);
  });

  it('rejects an object', () => {
    expect(isValidId({ id: 'abc' })).toBe(false);
  });

  it('rejects an array', () => {
    expect(isValidId(['abc'])).toBe(false);
  });
});
