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

  // =========================================================================
  // searchProducts filters (Phase 4C)
  // =========================================================================

  describe('searchProducts filters', () => {
    async function makeClassifications() {
      const catSnacks = await classificationRepository.create('category', {
        id: 'cat-snacks', name: 'Snacks', archived: false, isDefault: false
      });
      const catCleaning = await classificationRepository.create('category', {
        id: 'cat-cleaning', name: 'Cleaning', archived: false, isDefault: false
      });
      const locShelfA = await classificationRepository.create('location', {
        id: 'loc-shelf-a', name: 'Shelf A', archived: false, isDefault: false
      });
      const locWarehouse = await classificationRepository.create('location', {
        id: 'loc-warehouse', name: 'Warehouse', archived: false, isDefault: false
      });
      const locBackRoom = await classificationRepository.create('location', {
        id: 'loc-back-room', name: 'Back Room', archived: false, isDefault: false
      });
      const tagPopular = await classificationRepository.create('tag', {
        id: 'tag-popular', name: 'Popular', archived: false, isDefault: false
      });
      const tagSale = await classificationRepository.create('tag', {
        id: 'tag-sale', name: 'Sale', archived: false, isDefault: false
      });
      const tagFragile = await classificationRepository.create('tag', {
        id: 'tag-fragile', name: 'Fragile', archived: false, isDefault: false
      });
      return { catSnacks, catCleaning, locShelfA, locWarehouse, locBackRoom, tagPopular, tagSale, tagFragile };
    }

    it('category filter (single-select) narrows results to matching categoryId', async () => {
      const { catSnacks, catCleaning } = await makeClassifications();
      await service.createProduct({ name: 'Chips', categoryId: catSnacks.id });
      await service.createProduct({ name: 'Detergent', categoryId: catCleaning.id });

      const result = await service.searchProducts('', { categoryId: catSnacks.id });
      const names = result.matches.map((p) => p.name);
      expect(names).toContain('Chips');
      expect(names).not.toContain('Detergent');
    });

    it('location filter (multi-select) is OR -- matches ANY selected location', async () => {
      const { locShelfA, locWarehouse, locBackRoom } = await makeClassifications();
      await service.createProduct({ name: 'On Shelf A', locationIds: [locShelfA.id] });
      await service.createProduct({ name: 'In Warehouse', locationIds: [locWarehouse.id] });
      await service.createProduct({ name: 'In Back Room', locationIds: [locBackRoom.id] });

      const result = await service.searchProducts('', {
        locationIds: [locShelfA.id, locWarehouse.id]
      });
      const names = result.matches.map((p) => p.name);
      expect(names).toContain('On Shelf A');
      expect(names).toContain('In Warehouse');
      expect(names).not.toContain('In Back Room');
    });

    it('tag filter (multi-select) is OR -- matches ANY selected tag', async () => {
      const { tagPopular, tagSale, tagFragile } = await makeClassifications();
      await service.createProduct({ name: 'Popular Item', tagIds: [tagPopular.id] });
      await service.createProduct({ name: 'Sale Item', tagIds: [tagSale.id] });
      await service.createProduct({ name: 'Fragile Item', tagIds: [tagFragile.id] });

      const result = await service.searchProducts('', {
        tagIds: [tagPopular.id, tagSale.id]
      });
      const names = result.matches.map((p) => p.name);
      expect(names).toContain('Popular Item');
      expect(names).toContain('Sale Item');
      expect(names).not.toContain('Fragile Item');
    });

    it('category + location + tag filters combine as AND across groups', async () => {
      const { catSnacks, locShelfA, locWarehouse, tagPopular, tagSale } = await makeClassifications();

      // Matches all three groups.
      await service.createProduct({
        name: 'Match All', categoryId: catSnacks.id, locationIds: [locShelfA.id], tagIds: [tagPopular.id]
      });
      // Right category + location, wrong tag group entirely (no overlap).
      await service.createProduct({
        name: 'Wrong Tag', categoryId: catSnacks.id, locationIds: [locShelfA.id], tagIds: []
      });
      // Right category, wrong location.
      await service.createProduct({
        name: 'Wrong Location', categoryId: catSnacks.id, locationIds: [locWarehouse.id], tagIds: [tagPopular.id]
      });

      const result = await service.searchProducts('', {
        categoryId: catSnacks.id,
        locationIds: [locShelfA.id],
        tagIds: [tagPopular.id, tagSale.id]
      });
      const names = result.matches.map((p) => p.name);
      expect(names).toEqual(['Match All']);
    });

    it('filters-only (empty query) returns filtered products without invoking Fuse/domain search', async () => {
      const { catSnacks } = await makeClassifications();
      await service.createProduct({ name: 'Chips', categoryId: catSnacks.id });
      await service.createProduct({ name: 'Soap' });

      const result = await service.searchProducts('', { categoryId: catSnacks.id });

      expect(result.matches.map((p) => p.name)).toEqual(['Chips']);
      expect(result.related).toEqual([]);
      expect(result.hasExactMatch).toBe(false);
    });

    it('filters + text together narrow the candidate set before fuzzy search runs', async () => {
      const { catSnacks, catCleaning } = await makeClassifications();
      await service.createProduct({ name: 'Parle-G', categoryId: catSnacks.id });
      await service.createProduct({ name: 'Parle Marie', categoryId: catCleaning.id });

      // Fuzzy query "parleg" would normally match both by name -- the
      // category filter must exclude the one outside the filtered set.
      const result = await service.searchProducts('parleg', { categoryId: catSnacks.id });
      const names = result.matches.map((p) => p.name);
      expect(names).toContain('Parle-G');
      expect(names).not.toContain('Parle Marie');
    });

    it('no filters + text -- unchanged existing behavior', async () => {
      await service.createProduct({ name: 'Parle-G' });
      const result = await service.searchProducts('parleg');
      expect(result.matches.map((p) => p.name)).toContain('Parle-G');
    });

    it('no filters + no text -- unchanged existing empty-result behavior, no repository call', async () => {
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

    it('related results never include a product outside the active filters', async () => {
      const { catSnacks, catCleaning, locShelfA } = await makeClassifications();

      // Closest fuzzy match, inside the filter.
      await service.createProduct({
        name: 'Parle-G Biscuit', categoryId: catSnacks.id, locationIds: [locShelfA.id]
      });
      // Would be "related" by shared category if filters were ignored --
      // but it's in a DIFFERENT category, so under the active filter it's
      // never even a candidate.
      await service.createProduct({
        name: 'Detergent', categoryId: catCleaning.id, locationIds: [locShelfA.id]
      });
      // Shares category with the match, but OUTSIDE the location filter --
      // must not appear in related.
      await service.createProduct({
        name: 'Good Day', categoryId: catSnacks.id, locationIds: []
      });

      const result = await service.searchProducts('parleg', {
        categoryId: catSnacks.id,
        locationIds: [locShelfA.id]
      });

      const relatedNames = result.related.map((p) => p.name);
      expect(relatedNames).not.toContain('Detergent');
      expect(relatedNames).not.toContain('Good Day');
    });

    it('archived products remain excluded regardless of filter state', async () => {
      const { catSnacks } = await makeClassifications();
      const { product } = await service.createProduct({ name: 'Discontinued', categoryId: catSnacks.id });
      await service.updateProduct(product, { archived: true });

      const result = await service.searchProducts('', { categoryId: catSnacks.id });
      expect(result.matches.map((p) => p.id)).not.toContain(product.id);
    });
  });
});
