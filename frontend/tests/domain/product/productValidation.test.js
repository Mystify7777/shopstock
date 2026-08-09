import { describe, it, expect } from 'vitest';
import {
  hasValidIdentity,
  validateProduct,
  isProductValid
} from '../../../src/domain/product/productValidation.js';

describe('hasValidIdentity — PRD §4.1 identity rule', () => {
  it('is valid with name only', () => {
    expect(hasValidIdentity({ name: 'Parle-G' })).toBe(true);
  });

  it('is valid with photo only (name-less product)', () => {
    expect(hasValidIdentity({ photoRef: 'photo-abc123' })).toBe(true);
  });

  it('is valid with both name and photo', () => {
    expect(hasValidIdentity({ name: 'Parle-G', photoRef: 'photo-abc123' })).toBe(true);
  });

  it('is invalid with neither name nor photo', () => {
    expect(hasValidIdentity({})).toBe(false);
  });

  it('is invalid with empty-string name and no photo', () => {
    expect(hasValidIdentity({ name: '' })).toBe(false);
  });

  it('is invalid with whitespace-only name and no photo', () => {
    expect(hasValidIdentity({ name: '   ' })).toBe(false);
  });

  it('is invalid with empty-string photoRef and no name', () => {
    expect(hasValidIdentity({ photoRef: '' })).toBe(false);
  });

  it('is invalid with whitespace-only photoRef and no name', () => {
    expect(hasValidIdentity({ photoRef: '   ' })).toBe(false);
  });

  it('is valid with whitespace-padded but real name ("  Parle-G  ")', () => {
    expect(hasValidIdentity({ name: '  Parle-G  ' })).toBe(true);
  });

  it('is invalid for null input', () => {
    expect(hasValidIdentity(null)).toBe(false);
  });

  it('is invalid for undefined input', () => {
    expect(hasValidIdentity(undefined)).toBe(false);
  });

  it('is invalid for a non-object input', () => {
    expect(hasValidIdentity('Parle-G')).toBe(false);
  });

  it('ignores non-string name/photoRef values rather than throwing', () => {
    expect(hasValidIdentity({ name: 123, photoRef: null })).toBe(false);
  });
});

describe('validateProduct — full structural validation', () => {
  it('returns no errors for a minimal valid product (name only)', () => {
    expect(validateProduct({ name: 'Parle-G' })).toEqual([]);
  });

  it('returns no errors for a minimal valid product (photo only)', () => {
    expect(validateProduct({ photoRef: 'photo-abc' })).toEqual([]);
  });

  it('returns the identity error for a product with neither name nor photo', () => {
    const errors = validateProduct({});
    expect(errors).toContain('Product needs a name or photo.');
  });

  it('returns an error for negative quantity', () => {
    const errors = validateProduct({ name: 'Parle-G', quantity: -1 });
    expect(errors).toContain('Quantity cannot be negative.');
  });

  it('accepts zero quantity (out of stock is valid, not an error)', () => {
    const errors = validateProduct({ name: 'Parle-G', quantity: 0 });
    expect(errors).toEqual([]);
  });

  it('accepts decimal quantity (PRD §6 — units must support decimals)', () => {
    const errors = validateProduct({ name: 'Rice', quantity: 2.5 });
    expect(errors).toEqual([]);
  });

  it('returns an error for a non-numeric quantity', () => {
    const errors = validateProduct({ name: 'Parle-G', quantity: 'five' });
    expect(errors).toContain('Quantity must be a number.');
  });

  it('returns an error for a non-finite quantity', () => {
    const errors = validateProduct({ name: 'Parle-G', quantity: Infinity });
    expect(errors).toContain('Quantity must be a number.');
  });

  it('returns an error for a negative low-stock threshold', () => {
    const errors = validateProduct({ name: 'Parle-G', lowStockThreshold: -5 });
    expect(errors).toContain('Low-stock threshold cannot be negative.');
  });

  it('allows a null low-stock threshold (means "use global default")', () => {
    const errors = validateProduct({ name: 'Parle-G', lowStockThreshold: null });
    expect(errors).toEqual([]);
  });

  it('allows a null margin override (means "use global default")', () => {
    const errors = validateProduct({ name: 'Parle-G', marginOverride: null });
    expect(errors).toEqual([]);
  });

  it('allows a negative margin override (loss-leader pricing is a legitimate choice)', () => {
    const errors = validateProduct({ name: 'Parle-G', marginOverride: -10 });
    expect(errors).toEqual([]);
  });

  it('returns an error for a non-numeric margin override', () => {
    const errors = validateProduct({ name: 'Parle-G', marginOverride: 'high' });
    expect(errors).toContain('Margin must be a number.');
  });

  it('returns an error when locationIds is not an array', () => {
    const errors = validateProduct({ name: 'Parle-G', locationIds: 'Shelf A2' });
    expect(errors).toContain('Locations must be a list.');
  });

  it('returns an error when tagIds is not an array', () => {
    const errors = validateProduct({ name: 'Parle-G', tagIds: 'popular' });
    expect(errors).toContain('Tags must be a list.');
  });

  it('accepts empty locationIds/tagIds arrays', () => {
    const errors = validateProduct({ name: 'Parle-G', locationIds: [], tagIds: [] });
    expect(errors).toEqual([]);
  });

  it('returns an error for an invalid id when id is present', () => {
    const errors = validateProduct({ name: 'Parle-G', id: '' });
    expect(errors).toContain('Product is missing a valid id.');
  });

  it('does not require an id to be present at all (new, unsaved products)', () => {
    const errors = validateProduct({ name: 'Parle-G' });
    expect(errors).toEqual([]);
  });

  it('accumulates multiple errors at once rather than stopping at the first', () => {
    const errors = validateProduct({ quantity: -1, tagIds: 'not-an-array' });
    expect(errors).toContain('Product needs a name or photo.');
    expect(errors).toContain('Quantity cannot be negative.');
    expect(errors).toContain('Tags must be a list.');
    expect(errors.length).toBe(3);
  });

  it('returns a single message for completely missing/invalid product data', () => {
    expect(validateProduct(null)).toEqual(['Product data is missing or invalid.']);
    expect(validateProduct(undefined)).toEqual(['Product data is missing or invalid.']);
  });
});

describe('isProductValid', () => {
  it('is true for a valid product', () => {
    expect(isProductValid({ name: 'Parle-G', quantity: 10 })).toBe(true);
  });

  it('is false for an invalid product', () => {
    expect(isProductValid({ quantity: -1 })).toBe(false);
  });
});
