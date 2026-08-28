import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../data/db/schema.js';
import { createProductRepository } from '../data/repositories/productRepository.js';
import { createClassificationRepository } from '../data/repositories/classificationRepository.js';
import { createProductService } from './productService.js';

describe('productService', () => {
  let db;
  let repository;
  let classificationRepository;
  let service;

  beforeEach(() => {
    db = createDatabase();
    repository = createProductRepository(db);
    classificationRepository = createClassificationRepository(db);
    service = createProductService(repository, classificationRepository);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // =========================================================================
  // Constructor -- both repositories are required
  // =========================================================================

  describe('createProductService construction', () => {
    it('throws if productRepository is missing', () => {
      expect(() => createProductService(undefined, classificationRepository)).toThrow(TypeError);
    });

    it('throws if classificationRepository is missing', () => {
      expect(() => createProductService(repository, undefined)).toThrow(TypeError);
    });

    it('throws if both are missing', () => {
      expect(() => createProductService()).toThrow(TypeError);
    });

    it('constructs successfully when both are supplied', () => {
      expect(() => createProductService(repository, classificationRepository)).not.toThrow();
    });
  });

  // =========================================================================
  // listProducts
  // =========================================================================

  describe('listProducts', () => {
    it('returns an empty array with no products', async () => {
      expect(await service.listProducts()).toEqual([]);
    });

    it('returns created products', async () => {
      await service.createProduct({ name: 'Parle-G' });
      const products = await service.listProducts();
      expect(products).toHaveLength(1);
      expect(products[0].name).toBe('Parle-G');
    });
  });

  // =========================================================================
  // getProduct
  // =========================================================================

  describe('getProduct', () => {
    it('returns undefined for a missing id', async () => {
      expect(await service.getProduct('no-such-id')).toBeUndefined();
    });

    it('returns the product after create', async () => {
      const { product } = await service.createProduct({ name: 'Good Day' });
      const found = await service.getProduct(product.id);
      expect(found.name).toBe('Good Day');
    });
  });

  // =========================================================================
  // createProduct
  // =========================================================================

  describe('createProduct', () => {
    it('persists a valid product and returns it with no errors', async () => {
      const { product, errors } = await service.createProduct({ name: 'Bourbon' });
      expect(errors).toEqual([]);
      expect(product.name).toBe('Bourbon');
      const stored = await service.getProduct(product.id);
      expect(stored).toBeDefined();
    });

    it('returns errors and does not persist an invalid product', async () => {
      // Neither name nor photoRef present -- invalid per PRD identity rule.
      const { product, errors } = await service.createProduct({});
      expect(errors.length).toBeGreaterThan(0);
      const all = await service.listProducts();
      expect(all).toHaveLength(0);
      // product is still returned so the caller can show it back for correction
      expect(product).toBeDefined();
    });
  });

  // =========================================================================
  // updateProduct
  // =========================================================================

  describe('updateProduct', () => {
    it('persists a valid patch', async () => {
      const { product } = await service.createProduct({ name: 'Original' });
      const { product: updated, errors } = await service.updateProduct(
        product,
        { name: 'Renamed' }
      );
      expect(errors).toEqual([]);
      const stored = await service.getProduct(product.id);
      expect(stored.name).toBe('Renamed');
    });

    it('returns errors and does not persist an invalid patch', async () => {
      const { product } = await service.createProduct({ name: 'Keeper' });
      // Clearing the only name with no photoRef makes it identity-invalid.
      const { errors } = await service.updateProduct(product, { name: '' });
      expect(errors.length).toBeGreaterThan(0);
      const stored = await service.getProduct(product.id);
      expect(stored.name).toBe('Keeper'); // unchanged
    });

    it('cannot change quantity through the service', async () => {
      const { product } = await service.createProduct({ name: 'Locked Qty' });
      // updateProduct() throws synchronously (via domain updateProduct())
      // when a patch attempts to touch quantity.
      await expect(
        service.updateProduct(product, { quantity: 99 })
      ).rejects.toThrow();
    });

    it('a name change produces a ProductChangeEvent in the database', async () => {
      const { product } = await service.createProduct({ name: 'Before' });
      await service.updateProduct(product, { name: 'After' });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(1);
      expect(events[0].field).toBe('name');
      expect(events[0].oldValue).toBe('Before');
      expect(events[0].newValue).toBe('After');
      expect(events[0].productId).toBe(product.id);
    });

    it('a notes-only change produces zero ProductChangeEvents', async () => {
      const { product } = await service.createProduct({ name: 'Stable Name' });
      await service.updateProduct(product, { notes: 'a note' });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);
    });

    it('archiving via updateProduct produces an archived ProductChangeEvent', async () => {
      const { product } = await service.createProduct({ name: 'To Archive' });
      await service.updateProduct(product, { archived: true });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(1);
      expect(events[0].field).toBe('archived');
      expect(events[0].oldValue).toBe(false);
      expect(events[0].newValue).toBe(true);
    });

    it('multiple tracked-field changes in one patch produce one event per field', async () => {
      const { product } = await service.createProduct({ name: 'Multi', sellingPrice: 10 });
      await service.updateProduct(product, { name: 'Multi Changed', sellingPrice: 20 });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(2);
      const fields = events.map((e) => e.field).sort();
      expect(fields).toEqual(['name', 'sellingPrice']);
    });

    it('categoryId change produces an event with field "category"', async () => {
      const { product } = await service.createProduct({ name: 'Cat Test' });
      await service.updateProduct(product, { categoryId: 'cat-1' });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(1);
      expect(events[0].field).toBe('category');
    });

    it('locationIds array change produces an event with field "location"', async () => {
      const { product } = await service.createProduct({ name: 'Loc Test' });
      await service.updateProduct(product, { locationIds: ['shelf-a'] });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(1);
      expect(events[0].field).toBe('location');
    });

    it('an unchanged locationIds array (same contents) produces no event', async () => {
      const { product } = await service.createProduct({
        name: 'Same Array', locationIds: ['shelf-a', 'shelf-b']
      });
      await service.updateProduct(product, { locationIds: ['shelf-a', 'shelf-b'] });
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);
    });
  });

  // =========================================================================
  // searchProducts (Phase 4A)
  //
  // Real productRepository + classificationRepository, real fake-indexeddb
  // -- no mocking, matching every other service test file's convention.
  // =========================================================================

  describe('searchProducts', () => {
    it('returns empty results for an empty query without calling the repository', async () => {
      await service.createProduct({ name: 'Parle-G' });

      const listSpy = repository.list;
      let listCalled = false;
      repository.list = async (...args) => {
        listCalled = true;
        return listSpy(...args);
      };

      const result = await service.searchProducts('');

      expect(result).toEqual({ matches: [], related: [], hasExactMatch: false });
      expect(listCalled).toBe(false);

      repository.list = listSpy;
    });

    it('returns empty results for a whitespace-only query without calling the repository', async () => {
      const listSpy = repository.list;
      let listCalled = false;
      repository.list = async (...args) => {
        listCalled = true;
        return listSpy(...args);
      };

      const result = await service.searchProducts('   ');

      expect(result).toEqual({ matches: [], related: [], hasExactMatch: false });
      expect(listCalled).toBe(false);

      repository.list = listSpy;
    });

    it('finds a product by exact name match', async () => {
      await service.createProduct({ name: 'Parle-G' });
      const result = await service.searchProducts('Parle-G');
      expect(result.hasExactMatch).toBe(true);
      expect(result.matches.map((p) => p.name)).toContain('Parle-G');
    });

    it('finds a product by fuzzy/typo name match', async () => {
      await service.createProduct({ name: 'Parle-G' });
      const result = await service.searchProducts('parleg');
      expect(result.hasExactMatch).toBe(false);
      expect(result.matches.map((p) => p.name)).toContain('Parle-G');
    });

    it('resolves categoryId to the category name and matches on it', async () => {
      const category = await classificationRepository.create('category', {
        id: 'cat-snacks', name: 'Snacks', archived: false, isDefault: false
      });
      await service.createProduct({ name: 'Chips', categoryId: category.id });

      const result = await service.searchProducts('Snacks');
      expect(result.matches.map((p) => p.name)).toContain('Chips');
    });

    it('resolves tagIds to tag names and matches on them', async () => {
      const tag = await classificationRepository.create('tag', {
        id: 'tag-popular', name: 'popular', archived: false, isDefault: false
      });
      await service.createProduct({ name: 'Bestseller', tagIds: [tag.id] });

      const result = await service.searchProducts('popular');
      expect(result.matches.map((p) => p.name)).toContain('Bestseller');
    });

    it('resolves locationIds to location names and matches on them', async () => {
      const location = await classificationRepository.create('location', {
        id: 'loc-shelfa2', name: 'Shelf A2', archived: false, isDefault: false
      });
      await service.createProduct({ name: 'Cereal', locationIds: [location.id] });

      const result = await service.searchProducts('Shelf A2');
      expect(result.matches.map((p) => p.name)).toContain('Cereal');
    });

    it('excludes archived products from search results', async () => {
      const { product } = await service.createProduct({ name: 'Discontinued Item' });
      await service.updateProduct(product, { archived: true });

      const result = await service.searchProducts('Discontinued');
      expect(result.matches.map((p) => p.id)).not.toContain(product.id);
    });

    it('a dangling categoryId (no matching classification record) does not crash search', async () => {
      await service.createProduct({ name: 'Orphaned Category Product', categoryId: 'nonexistent-cat-id' });
      const result = await service.searchProducts('Orphaned');
      expect(result.matches.map((p) => p.name)).toContain('Orphaned Category Product');
    });

    it('a dangling tagId (no matching classification record) does not crash search', async () => {
      await service.createProduct({ name: 'Orphaned Tag Product', tagIds: ['nonexistent-tag-id'] });
      const result = await service.searchProducts('Orphaned');
      expect(result.matches.map((p) => p.name)).toContain('Orphaned Tag Product');
    });

    it('a dangling locationId (no matching classification record) does not crash search', async () => {
      const { product } = await service.createProduct({
        name: 'Orphaned Location Product', locationIds: ['nonexistent-loc-id']
      });
      const result = await service.searchProducts('Orphaned');
      expect(result.matches.map((p) => p.name)).toContain('Orphaned Location Product');

      // The unresolved location must simply not appear in the transient
      // projection -- and the Product object itself must remain unchanged.
      const stored = await service.getProduct(product.id);
      expect(stored.locationIds).toEqual(['nonexistent-loc-id']); // untouched
    });

    it('the transient search projection does not mutate the stored product', async () => {
      const { product } = await service.createProduct({ name: 'Untouched' });
      await service.searchProducts('Untouched');
      const stored = await service.getProduct(product.id);
      expect(stored).toEqual(product);
    });

    it('returns an empty matches array when nothing matches', async () => {
      await service.createProduct({ name: 'Parle-G' });
      const result = await service.searchProducts('zzznomatchzzz');
      expect(result.matches).toEqual([]);
      expect(result.hasExactMatch).toBe(false);
    });
  });
});
