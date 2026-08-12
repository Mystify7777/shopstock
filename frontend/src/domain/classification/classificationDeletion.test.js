import { describe, it, expect } from 'vitest';
import {
  findProductsUsingCategory,
  findProductsUsingLocation,
  findProductsUsingTag,
  applyCategoryDeletionFallback,
  applyLocationDeletionFallback,
  applyTagDeletionFallback,
  previewClassificationDeletion
} from '../../../src/domain/classification/classificationDeletion.js';

function product(overrides = {}) {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Test Product',
    categoryId: overrides.categoryId ?? null,
    locationIds: overrides.locationIds ?? [],
    tagIds: overrides.tagIds ?? []
  };
}

describe('1. Category deletion — affected products become uncategorized', () => {
  it('nulls categoryId for a matching product', () => {
    const p = product({ categoryId: 'cat-snacks' });
    const updated = applyCategoryDeletionFallback(p, 'cat-snacks');
    expect(updated.categoryId).toBeNull();
  });

  it('previewClassificationDeletion applies the same fallback to all affected products', () => {
    const products = [
      product({ id: 'p1', categoryId: 'cat-snacks' }),
      product({ id: 'p2', categoryId: 'cat-snacks' }),
      product({ id: 'p3', categoryId: 'cat-drinks' })
    ];
    const result = previewClassificationDeletion('category', 'cat-snacks', products);
    expect(result.updatedProducts.every((p) => p.categoryId === null)).toBe(true);
    expect(result.affectedCount).toBe(2);
  });
});

describe('2. Location deletion — only the deleted location ID disappears', () => {
  it('removes only the matching locationId', () => {
    const p = product({ locationIds: ['shelf-a1', 'shelf-a2'] });
    const updated = applyLocationDeletionFallback(p, 'shelf-a1');
    expect(updated.locationIds).toEqual(['shelf-a2']);
  });

  it('does not affect a product that never referenced the location', () => {
    const p = product({ locationIds: ['shelf-a2'] });
    const updated = applyLocationDeletionFallback(p, 'shelf-a1');
    expect(updated.locationIds).toEqual(['shelf-a2']);
  });

  it('results in an empty array (not a fallback placeholder value) when it was the only location', () => {
    const p = product({ locationIds: ['shelf-a1'] });
    const updated = applyLocationDeletionFallback(p, 'shelf-a1');
    expect(updated.locationIds).toEqual([]);
  });
});

describe('3. Tag deletion — only the deleted tag ID disappears', () => {
  it('removes only the matching tagId', () => {
    const p = product({ tagIds: ['popular', 'seasonal'] });
    const updated = applyTagDeletionFallback(p, 'popular');
    expect(updated.tagIds).toEqual(['seasonal']);
  });

  it('results in an empty array when it was the only tag, with no fallback value substituted', () => {
    const p = product({ tagIds: ['popular'] });
    const updated = applyTagDeletionFallback(p, 'popular');
    expect(updated.tagIds).toEqual([]);
  });
});

describe('4. Products with multiple locations/tags retain all other references', () => {
  it('preserves every other location when one is deleted', () => {
    const p = product({ locationIds: ['shelf-a1', 'shelf-a2', 'back-room', 'counter'] });
    const updated = applyLocationDeletionFallback(p, 'back-room');
    expect(updated.locationIds).toEqual(['shelf-a1', 'shelf-a2', 'counter']);
  });

  it('preserves every other tag when one is deleted', () => {
    const p = product({ tagIds: ['popular', 'seasonal', 'fragile', 'clearance'] });
    const updated = applyTagDeletionFallback(p, 'seasonal');
    expect(updated.tagIds).toEqual(['popular', 'fragile', 'clearance']);
  });
});

describe('5. Products without the deleted reference remain unchanged', () => {
  it('category fallback is a no-op for a product with a different category', () => {
    const p = product({ categoryId: 'cat-drinks' });
    const updated = applyCategoryDeletionFallback(p, 'cat-snacks');
    expect(updated.categoryId).toBe('cat-drinks');
  });

  it('location fallback is a no-op for a product without that location', () => {
    const p = product({ locationIds: ['shelf-a2'] });
    const updated = applyLocationDeletionFallback(p, 'shelf-a1');
    expect(updated.locationIds).toEqual(['shelf-a2']);
  });

  it('tag fallback is a no-op for a product without that tag', () => {
    const p = product({ tagIds: ['fragile'] });
    const updated = applyTagDeletionFallback(p, 'popular');
    expect(updated.tagIds).toEqual(['fragile']);
  });

  it('a product with null categoryId is unaffected by deleting an unrelated category', () => {
    const p = product({ categoryId: null });
    const updated = applyCategoryDeletionFallback(p, 'cat-snacks');
    expect(updated.categoryId).toBeNull();
  });
});

describe('6. Multiple affected products are all accounted for', () => {
  it('finds every product using a category', () => {
    const products = [
      product({ id: 'p1', categoryId: 'cat-snacks' }),
      product({ id: 'p2', categoryId: 'cat-drinks' }),
      product({ id: 'p3', categoryId: 'cat-snacks' }),
      product({ id: 'p4', categoryId: 'cat-snacks' })
    ];
    const found = findProductsUsingCategory(products, 'cat-snacks');
    expect(found.map((p) => p.id)).toEqual(['p1', 'p3', 'p4']);
  });

  it('finds every product using a location', () => {
    const products = [
      product({ id: 'p1', locationIds: ['shelf-a1'] }),
      product({ id: 'p2', locationIds: ['shelf-a2'] }),
      product({ id: 'p3', locationIds: ['shelf-a1', 'back-room'] })
    ];
    const found = findProductsUsingLocation(products, 'shelf-a1');
    expect(found.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('finds every product using a tag', () => {
    const products = [
      product({ id: 'p1', tagIds: ['popular'] }),
      product({ id: 'p2', tagIds: ['clearance'] }),
      product({ id: 'p3', tagIds: ['popular', 'fragile'] })
    ];
    const found = findProductsUsingTag(products, 'popular');
    expect(found.map((p) => p.id)).toEqual(['p1', 'p3']);
  });
});

describe('7. Zero affected products is valid', () => {
  it('returns an empty result set when no product uses the category', () => {
    const products = [product({ id: 'p1', categoryId: 'cat-drinks' })];
    const result = previewClassificationDeletion('category', 'cat-snacks', products);
    expect(result.affectedCount).toBe(0);
    expect(result.affectedProducts).toEqual([]);
    expect(result.updatedProducts).toEqual([]);
  });

  it('returns an empty result set for an empty products list entirely', () => {
    const result = previewClassificationDeletion('tag', 'popular', []);
    expect(result.affectedCount).toBe(0);
  });

  it('handles a missing/non-array products argument defensively (treats as no products)', () => {
    expect(findProductsUsingCategory(null, 'cat-1')).toEqual([]);
    expect(findProductsUsingLocation(undefined, 'loc-1')).toEqual([]);
  });
});

describe('8. Original product objects/arrays are not mutated', () => {
  it('applyCategoryDeletionFallback does not mutate the original product', () => {
    const p = product({ categoryId: 'cat-snacks' });
    applyCategoryDeletionFallback(p, 'cat-snacks');
    expect(p.categoryId).toBe('cat-snacks');
  });

  it('applyLocationDeletionFallback does not mutate the original product or its array', () => {
    const p = product({ locationIds: ['shelf-a1', 'shelf-a2'] });
    const originalArray = p.locationIds;
    applyLocationDeletionFallback(p, 'shelf-a1');
    expect(p.locationIds).toEqual(['shelf-a1', 'shelf-a2']);
    expect(p.locationIds).toBe(originalArray); // same array reference, untouched
  });

  it('applyTagDeletionFallback does not mutate the original product or its array', () => {
    const p = product({ tagIds: ['popular', 'seasonal'] });
    const originalArray = p.tagIds;
    applyTagDeletionFallback(p, 'popular');
    expect(p.tagIds).toEqual(['popular', 'seasonal']);
    expect(p.tagIds).toBe(originalArray);
  });

  it('previewClassificationDeletion does not mutate any product in the input array', () => {
    const products = [
      product({ id: 'p1', locationIds: ['shelf-a1'] }),
      product({ id: 'p2', locationIds: ['shelf-a1', 'back-room'] })
    ];
    const snapshot = JSON.parse(JSON.stringify(products));
    previewClassificationDeletion('location', 'shelf-a1', products);
    expect(products).toEqual(snapshot);
  });
});

describe('9. Unknown classification type is rejected rather than guessed', () => {
  it('throws for an unrecognized classificationType', () => {
    const products = [product()];
    expect(() => previewClassificationDeletion('unit', 'unit-kg', products)).toThrow(TypeError);
    expect(() => previewClassificationDeletion('supplier', 'sup-1', products)).toThrow(TypeError);
    expect(() => previewClassificationDeletion(undefined, 'x', products)).toThrow(TypeError);
  });

  it('throws for a missing/empty classificationId', () => {
    const products = [product()];
    expect(() => previewClassificationDeletion('category', '', products)).toThrow(TypeError);
    expect(() => previewClassificationDeletion('category', null, products)).toThrow(TypeError);
  });
});

describe('10. No product is physically deleted by the domain helper', () => {
  it('previewClassificationDeletion never reduces the product count — it only returns fallback previews', () => {
    const products = [
      product({ id: 'p1', categoryId: 'cat-snacks' }),
      product({ id: 'p2', categoryId: 'cat-snacks' })
    ];
    const result = previewClassificationDeletion('category', 'cat-snacks', products);
    expect(result.updatedProducts.length).toBe(result.affectedProducts.length);
    expect(result.updatedProducts.length).toBe(2);
    expect(products.length).toBe(2);
  });

  it('this module exposes no delete/remove-product function at all', async () => {
    const module = await import('../../../src/domain/classification/classificationDeletion.js');
    const exportNames = Object.keys(module);
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toMatch(/deleteproduct|removeproduct/);
    }
  });
});

describe('11. The affected count matches the actual affected products', () => {
  it('affectedCount always equals affectedProducts.length', () => {
    const products = [
      product({ id: 'p1', tagIds: ['popular'] }),
      product({ id: 'p2', tagIds: ['popular', 'fragile'] }),
      product({ id: 'p3', tagIds: ['clearance'] }),
      product({ id: 'p4', tagIds: ['popular'] })
    ];
    const result = previewClassificationDeletion('tag', 'popular', products);
    expect(result.affectedCount).toBe(result.affectedProducts.length);
    expect(result.affectedCount).toBe(3);
  });
});

describe('12. Duplicate references within one product do not inflate the affected-product count', () => {
  it('a product with the same tag listed twice is still counted once', () => {
    const products = [
      product({ id: 'p1', tagIds: ['popular', 'popular'] }), // malformed but defensively handled
      product({ id: 'p2', tagIds: ['clearance'] })
    ];
    const result = previewClassificationDeletion('tag', 'popular', products);
    expect(result.affectedCount).toBe(1);
    expect(result.affectedProducts.map((p) => p.id)).toEqual(['p1']);
  });

  it('a product with the same location listed twice is still counted once', () => {
    const products = [product({ id: 'p1', locationIds: ['shelf-a1', 'shelf-a1'] })];
    const result = previewClassificationDeletion('location', 'shelf-a1', products);
    expect(result.affectedCount).toBe(1);
  });

  it('removing a duplicated location reference removes all occurrences, not just one', () => {
    const p = product({ locationIds: ['shelf-a1', 'shelf-a1', 'back-room'] });
    const updated = applyLocationDeletionFallback(p, 'shelf-a1');
    expect(updated.locationIds).toEqual(['back-room']);
  });
});

describe('previewClassificationDeletion — general shape', () => {
  it('returns the classificationType and classificationId echoed back for convenience', () => {
    const result = previewClassificationDeletion('category', 'cat-snacks', []);
    expect(result.classificationType).toBe('category');
    expect(result.classificationId).toBe('cat-snacks');
  });

  it('affectedProducts contains the ORIGINAL (pre-fallback) product objects', () => {
    const products = [product({ id: 'p1', categoryId: 'cat-snacks' })];
    const result = previewClassificationDeletion('category', 'cat-snacks', products);
    expect(result.affectedProducts[0].categoryId).toBe('cat-snacks');
    expect(result.updatedProducts[0].categoryId).toBeNull();
  });

  it('updatedProducts is in the same order and length as affectedProducts', () => {
    const products = [
      product({ id: 'p1', categoryId: 'cat-snacks' }),
      product({ id: 'p2', categoryId: 'cat-snacks' }),
      product({ id: 'p3', categoryId: 'cat-snacks' })
    ];
    const result = previewClassificationDeletion('category', 'cat-snacks', products);
    expect(result.updatedProducts.map((p) => p.id)).toEqual(
      result.affectedProducts.map((p) => p.id)
    );
  });
});
