import { describe, it, expect } from 'vitest';
import {
  createProduct,
  updateProduct,
  LOCKED_PRODUCT_UPDATE_FIELDS
} from '../../../src/domain/product/productFactory.js';
import { isValidId } from '../../../src/domain/shared/ids.js';
import { isValidTimestamp } from '../../../src/domain/shared/dates.js';

describe('createProduct', () => {
  it('creates a valid product with just a name', () => {
    const { product, errors } = createProduct({ name: 'Parle-G' });
    expect(errors).toEqual([]);
    expect(product.name).toBe('Parle-G');
  });

  it('creates a valid product with just a photo', () => {
    const { product, errors } = createProduct({ photoRef: 'photo-abc' });
    expect(errors).toEqual([]);
    expect(product.photoRef).toBe('photo-abc');
  });

  it('generates a valid id when none is provided', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(isValidId(product.id)).toBe(true);
  });

  it('generates distinct ids for distinct products', () => {
    const a = createProduct({ name: 'A' }).product;
    const b = createProduct({ name: 'B' }).product;
    expect(a.id).not.toBe(b.id);
  });

  it('sets createdAt and updatedAt to valid, equal timestamps at creation', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(isValidTimestamp(product.createdAt)).toBe(true);
    expect(isValidTimestamp(product.updatedAt)).toBe(true);
    expect(product.createdAt).toBe(product.updatedAt);
  });

  it('defaults quantity to 0, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.quantity).toBe(0);
  });

  it('accepts an explicit starting quantity', () => {
    const { product } = createProduct({ name: 'Parle-G', quantity: 25 });
    expect(product.quantity).toBe(25);
  });

  it('defaults archived to false, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.archived).toBe(false);
  });

  it('defaults locationIds to an empty array, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.locationIds).toEqual([]);
  });

  it('defaults tagIds to an empty array, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.tagIds).toEqual([]);
  });

  it('defaults lowStockDisabled to false, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.lowStockDisabled).toBe(false);
  });

  it('defaults nullable fields (categoryId, marginOverride, etc.) to null, not undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    expect(product.categoryId).toBeNull();
    expect(product.unitId).toBeNull();
    expect(product.lowStockThreshold).toBeNull();
    expect(product.sellingPrice).toBeNull();
    expect(product.marginOverride).toBeNull();
    expect(product.latestPurchaseDate).toBeNull();
    expect(product.notes).toBeNull();
    expect(product.photoRef).toBeNull();
  });

  it('no field on a freshly created product is ever undefined', () => {
    const { product } = createProduct({ name: 'Parle-G' });
    for (const [key, value] of Object.entries(product)) {
      expect(value, `field "${key}" should not be undefined`).not.toBeUndefined();
    }
  });

  it('returns validation errors for an identity-less product rather than throwing', () => {
    const { product, errors } = createProduct({});
    expect(product).toBeDefined();
    expect(errors).toContain('Product needs a name or photo.');
  });

  it('preserves an explicitly provided valid id instead of generating a new one', () => {
    const { product } = createProduct({ name: 'Parle-G', id: 'fixed-test-id-1' });
    expect(product.id).toBe('fixed-test-id-1');
  });
});

describe('updateProduct — patch semantics (not merge-with-defaults)', () => {
  function makeBaseProduct() {
    return createProduct({ name: 'Parle-G', quantity: 10, notes: 'Popular item' }).product;
  }

  it('applies a simple field change', () => {
    const base = makeBaseProduct();
    const { product, errors } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(errors).toEqual([]);
    expect(product.name).toBe('Parle-G Gold');
  });

  it('leaves fields not mentioned in the patch untouched', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(product.notes).toBe('Popular item');
  });

  it('applies an explicit null to clear a nullable field (distinct from omission)', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { notes: null });
    expect(product.notes).toBeNull();
  });

  it('applies falsy-but-meaningful values instead of treating them as missing', () => {
    const base = createProduct({ name: 'Parle-G', marginOverride: 20 }).product;
    const { product } = updateProduct(base, { marginOverride: 0 });
    expect(product.marginOverride).toBe(0);
  });

  it('applies an explicit empty string, distinct from omitting the field', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { notes: '' });
    expect(product.notes).toBe('');
  });

  it('applies lowStockDisabled: false explicitly without confusing it for omission', () => {
    const base = createProduct({ name: 'Parle-G', lowStockDisabled: true }).product;
    const { product } = updateProduct(base, { lowStockDisabled: false });
    expect(product.lowStockDisabled).toBe(false);
  });

  it('updates updatedAt on every patch', async () => {
    const base = makeBaseProduct();
    // Ensure a strictly-later timestamp is possible even on very fast runs.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { product } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(product.updatedAt).not.toBe(base.updatedAt);
    expect(product.updatedAt > base.updatedAt).toBe(true);
  });

  it('preserves createdAt across an update', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(product.createdAt).toBe(base.createdAt);
  });

  it('preserves id across an update', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(product.id).toBe(base.id);
  });

  it('preserves quantity across an unrelated update', () => {
    const base = makeBaseProduct();
    const { product } = updateProduct(base, { name: 'Parle-G Gold' });
    expect(product.quantity).toBe(10);
  });

  it('re-validates the result and surfaces new errors (e.g. clearing both name and photo)', () => {
    const base = makeBaseProduct();
    const { errors } = updateProduct(base, { name: null });
    expect(errors).toContain('Product needs a name or photo.');
  });

  it('does not mutate the original product object', () => {
    const base = makeBaseProduct();
    const snapshotName = base.name;
    updateProduct(base, { name: 'Changed' });
    expect(base.name).toBe(snapshotName);
  });
});

describe('updateProduct — locked fields', () => {
  it('throws if patch attempts to set id', () => {
    const base = createProduct({ name: 'Parle-G' }).product;
    expect(() => updateProduct(base, { id: 'new-id' })).toThrow(TypeError);
  });

  it('throws if patch attempts to set createdAt', () => {
    const base = createProduct({ name: 'Parle-G' }).product;
    expect(() => updateProduct(base, { createdAt: '2020-01-01T00:00:00.000Z' })).toThrow(
      TypeError
    );
  });

  it('throws if patch attempts to set quantity to a new value', () => {
    const base = createProduct({ name: 'Parle-G', quantity: 10 }).product;
    expect(() => updateProduct(base, { quantity: 37 })).toThrow(TypeError);
  });

  it('throws if patch attempts to set quantity even to its current value', () => {
    const base = createProduct({ name: 'Parle-G', quantity: 10 }).product;
    // Deliberately strict: including "quantity" in a patch at all is
    // treated as a caller-error signal, regardless of the value given.
    expect(() => updateProduct(base, { quantity: 10 })).toThrow(TypeError);
  });

  it('throws if patch attempts to set quantity to 0', () => {
    const base = createProduct({ name: 'Parle-G', quantity: 10 }).product;
    expect(() => updateProduct(base, { quantity: 0 })).toThrow(TypeError);
  });

  it('does not throw when other fields are updated alongside a valid patch', () => {
    const base = createProduct({ name: 'Parle-G', quantity: 10 }).product;
    expect(() =>
      updateProduct(base, { name: 'New name', notes: 'updated' })
    ).not.toThrow();
  });

  it('exposes the locked field list for callers/tests to reference', () => {
    expect(LOCKED_PRODUCT_UPDATE_FIELDS).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'quantity'])
    );
    expect(LOCKED_PRODUCT_UPDATE_FIELDS.length).toBe(3);
  });
});

describe('updateProduct — input guards', () => {
  it('throws if product is missing', () => {
    expect(() => updateProduct(null, { name: 'X' })).toThrow(TypeError);
  });

  it('throws if product is not an object', () => {
    expect(() => updateProduct('not-a-product', { name: 'X' })).toThrow(TypeError);
  });

  it('throws if patch is an array', () => {
    const base = createProduct({ name: 'Parle-G' }).product;
    expect(() => updateProduct(base, ['not', 'a', 'patch'])).toThrow(TypeError);
  });

  it('defaults to an empty patch (no-op update) when patch is omitted', () => {
    const base = createProduct({ name: 'Parle-G' }).product;
    const { product, errors } = updateProduct(base);
    expect(errors).toEqual([]);
    expect(product.name).toBe('Parle-G');
  });
});
