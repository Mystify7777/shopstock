import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../data/db/schema.js';
import { createProductRepository } from '../data/repositories/productRepository.js';
import {
  createClassificationRepository,
  ClassificationNotFoundError
} from '../data/repositories/classificationRepository.js';
import { createProductService } from './productService.js';
import {
  createClassificationService,
  ClassificationRemovalNotSupportedError
} from './classificationService.js';

// Real repositories on fake-indexeddb (never mocked). Failure paths are
// injected by wrapping a real dependency, so everything else stays real.

describe('classificationService', () => {
  let db;
  let classificationRepository;
  let productService;
  let service;

  beforeEach(() => {
    db = createDatabase();
    const productRepository = createProductRepository(db);
    classificationRepository = createClassificationRepository(db);
    productService = createProductService(productRepository, classificationRepository);
    service = createClassificationService(classificationRepository, productService);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  async function makeClassification(type, name) {
    const { classification, errors } = await service.create(type, name);
    expect(errors).toEqual([]);
    return classification;
  }

  async function makeProduct(input = {}) {
    const { product, errors } = await productService.createProduct({ name: 'Product', ...input });
    expect(errors).toEqual([]);
    return product;
  }

  const reload = (id) => productService.getProduct(id);
  const syncEntriesFor = async (entityType) =>
    (await db.syncQueue.toArray()).filter((e) => e.entityType === entityType);

  describe('construction', () => {
    it('requires both dependencies', () => {
      expect(() => createClassificationService(undefined, productService)).toThrow(TypeError);
      expect(() => createClassificationService(classificationRepository)).toThrow(TypeError);
    });
  });

  describe.each(['category', 'location', 'tag', 'unit'])('%s basics', (type) => {
    describe('create', () => {
      it('persists a trimmed, active, non-default record and queues it for sync', async () => {
        const { classification, errors } = await service.create(type, '  Snacks  ');
        expect(errors).toEqual([]);
        expect(classification).toMatchObject({ name: 'Snacks', archived: false, isDefault: false });
        expect(typeof classification.id).toBe('string');
        expect(await classificationRepository.getById(type, classification.id)).toEqual(classification);

        const queued = await syncEntriesFor(type);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ operation: 'upsert', entityId: classification.id });
      });

      it.each(['', '   ', null, undefined, 42])('rejects the blank name %j and persists nothing', async (bad) => {
        const result = await service.create(type, bad);
        expect(result.classification).toBeNull();
        expect(result.errors).toEqual(['Name is required.']);
        expect(await service.list(type, { includeArchived: true })).toEqual([]);
        expect(await syncEntriesFor(type)).toEqual([]);
      });

      it('allows a duplicate name (no uniqueness rule exists)', async () => {
        await makeClassification(type, 'Same');
        const second = await service.create(type, 'same');
        expect(second.errors).toEqual([]);
        expect(await service.list(type)).toHaveLength(2);
      });
    });

    describe('list', () => {
      it('excludes archived by default and includes them on request', async () => {
        const active = await makeClassification(type, 'Active');
        const archived = await makeClassification(type, 'Old');
        await service.archive(type, archived.id);

        expect((await service.list(type)).map((c) => c.id)).toEqual([active.id]);
        expect((await service.list(type, { includeArchived: true })).map((c) => c.id).sort()).toEqual(
          [active.id, archived.id].sort()
        );
      });
    });

    describe('rename', () => {
      it('updates the name (trimmed) and queues a sync entry', async () => {
        const item = await makeClassification(type, 'Old');
        const { classification, errors } = await service.rename(type, item.id, '  New  ');
        expect(errors).toEqual([]);
        expect(classification.name).toBe('New');
        expect((await classificationRepository.getById(type, item.id)).name).toBe('New');
        expect(await syncEntriesFor(type)).toHaveLength(2); // create + rename
      });

      it('preserves archived and isDefault', async () => {
        const item = await makeClassification(type, 'Old');
        await classificationRepository.update(type, { ...item, isDefault: true });
        await service.rename(type, item.id, 'New');
        expect(await classificationRepository.getById(type, item.id)).toMatchObject({
          name: 'New',
          archived: false,
          isDefault: true
        });
      });

      it('is a no-op (nothing written or queued) when the name is unchanged', async () => {
        const item = await makeClassification(type, 'Same');
        const before = (await syncEntriesFor(type)).length;
        await service.rename(type, item.id, '  Same ');
        expect((await syncEntriesFor(type)).length).toBe(before);
      });

      it('rejects a blank name and leaves the record alone', async () => {
        const item = await makeClassification(type, 'Keep');
        const result = await service.rename(type, item.id, '  ');
        expect(result.errors).toEqual(['Name is required.']);
        expect((await classificationRepository.getById(type, item.id)).name).toBe('Keep');
      });

      it('reports a missing record instead of throwing', async () => {
        const result = await service.rename(type, 'nope', 'X');
        expect(result.classification).toBeNull();
        expect(result.errors).toHaveLength(1);
      });
    });

    describe('archive / restore', () => {
      it('archives and restores, preserving every other field', async () => {
        const item = await makeClassification(type, 'Thing');
        await classificationRepository.update(type, { ...item, isDefault: true });

        await service.archive(type, item.id);
        expect(await classificationRepository.getById(type, item.id)).toMatchObject({
          name: 'Thing',
          archived: true,
          isDefault: true
        });

        await service.restore(type, item.id);
        expect(await classificationRepository.getById(type, item.id)).toMatchObject({
          archived: false,
          isDefault: true
        });
      });

      it('queues a sync entry for each real change but not for a no-op', async () => {
        const item = await makeClassification(type, 'Thing');
        const afterCreate = (await syncEntriesFor(type)).length;
        await service.archive(type, item.id);
        await service.archive(type, item.id); // already archived: no-op
        expect((await syncEntriesFor(type)).length).toBe(afterCreate + 1);
      });

      it('reports a missing record instead of throwing', async () => {
        expect((await service.archive(type, 'nope')).errors).toHaveLength(1);
        expect((await service.restore(type, 'nope')).errors).toHaveLength(1);
      });

      it('does not touch any product', async () => {
        const item = await makeClassification(type, 'Thing');
        const field = { category: 'categoryId', location: 'locationIds', tag: 'tagIds' }[type];
        const input = field === 'categoryId' ? { categoryId: item.id } : field ? { [field]: [item.id] } : {};
        const product = await makeProduct(input);
        await service.archive(type, item.id);
        expect(await reload(product.id)).toEqual(product);
      });
    });
  });

  describe('previewRemoval', () => {
    it('counts affected products using the domain definition, across active AND archived', async () => {
      const cat = await makeClassification('category', 'Snacks');
      await makeProduct({ name: 'A', categoryId: cat.id });
      await makeProduct({ name: 'B', categoryId: cat.id });
      const archivedProduct = await makeProduct({ name: 'C', categoryId: cat.id });
      await productService.updateProduct(archivedProduct, { archived: true });
      await makeProduct({ name: 'Other', categoryId: 'some-other-category' });
      await makeProduct({ name: 'None' });

      const preview = await service.previewRemoval('category', cat.id);
      expect(preview.affectedCount).toBe(3);
      expect(preview.affectedProducts.map((p) => p.name).sort()).toEqual(['A', 'B', 'C']);
      expect(preview.archivedAffectedCount).toBe(1);
      expect(preview.classification.id).toBe(cat.id);
    });

    it.each([
      ['location', 'locationIds'],
      ['tag', 'tagIds']
    ])('counts a product once for a %s held among several', async (type, field) => {
      const item = await makeClassification(type, 'X');
      const other = await makeClassification(type, 'Y');
      await makeProduct({ [field]: [item.id, other.id] });
      await makeProduct({ [field]: [other.id] });
      expect((await service.previewRemoval(type, item.id)).affectedCount).toBe(1);
    });

    it('reports zero when nothing uses it', async () => {
      const cat = await makeClassification('category', 'Unused');
      expect((await service.previewRemoval('category', cat.id)).affectedCount).toBe(0);
    });

    it('persists nothing', async () => {
      const cat = await makeClassification('category', 'Snacks');
      const product = await makeProduct({ categoryId: cat.id });
      const queueBefore = await db.syncQueue.count();

      await service.previewRemoval('category', cat.id);

      expect(await reload(product.id)).toEqual(product);
      expect(await classificationRepository.getById('category', cat.id)).toEqual(cat);
      expect(await db.syncQueue.count()).toBe(queueBefore);
    });

    it('refuses units', async () => {
      const unit = await makeClassification('unit', 'Kg');
      await expect(service.previewRemoval('unit', unit.id)).rejects.toThrow(
        ClassificationRemovalNotSupportedError
      );
    });

    it('throws for a missing classification', async () => {
      await expect(service.previewRemoval('category', 'nope')).rejects.toThrow(ClassificationNotFoundError);
    });
  });

  describe('removeWithFallback', () => {
    describe('category -> Uncategorized', () => {
      it('clears categoryId on every affected product, archives the category, deletes nothing', async () => {
        const cat = await makeClassification('category', 'Snacks');
        const keepCat = await makeClassification('category', 'Drinks');
        const a = await makeProduct({ name: 'A', categoryId: cat.id, notes: 'keep me' });
        const b = await makeProduct({ name: 'B', categoryId: cat.id });
        const unaffected = await makeProduct({ name: 'C', categoryId: keepCat.id });

        const result = await service.removeWithFallback('category', cat.id);

        expect(result).toMatchObject({
          status: 'completed',
          affectedCount: 2,
          updatedCount: 2,
          skippedCount: 0,
          failures: [],
          archiveError: null,
          retryable: false
        });
        expect((await reload(a.id)).categoryId).toBeNull();
        expect((await reload(b.id)).categoryId).toBeNull();
        expect((await reload(unaffected.id)).categoryId).toBe(keepCat.id);
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(true);
        // other fields untouched, nothing deleted or archived
        expect((await reload(a.id)).notes).toBe('keep me');
        expect((await reload(a.id)).archived).toBe(false);
        expect(await db.products.count()).toBe(3);
      });

      it('records a product change event for each updated product', async () => {
        const cat = await makeClassification('category', 'Snacks');
        const product = await makeProduct({ categoryId: cat.id });
        await service.removeWithFallback('category', cat.id);
        const events = await db.productChangeEvents.where('productId').equals(product.id).toArray();
        expect(events.length).toBeGreaterThan(0);
      });

      it('also fixes archived products so none keeps a reference to the removed category', async () => {
        const cat = await makeClassification('category', 'Snacks');
        const p = await makeProduct({ categoryId: cat.id });
        await productService.updateProduct(p, { archived: true });
        await service.removeWithFallback('category', cat.id);
        const after = await reload(p.id);
        expect(after.categoryId).toBeNull();
        expect(after.archived).toBe(true); // still archived, not deleted
      });
    });

    describe.each([
      ['location', 'locationIds'],
      ['tag', 'tagIds']
    ])('%s -> removed from the array', (type, field) => {
      it('removes only that id and keeps the product\'s others', async () => {
        const target = await makeClassification(type, 'Target');
        const other = await makeClassification(type, 'Other');
        const both = await makeProduct({ name: 'both', [field]: [other.id, target.id] });
        const only = await makeProduct({ name: 'only', [field]: [target.id] });
        const untouched = await makeProduct({ name: 'untouched', [field]: [other.id] });

        const result = await service.removeWithFallback(type, target.id);

        expect(result.status).toBe('completed');
        expect((await reload(both.id))[field]).toEqual([other.id]);
        expect((await reload(only.id))[field]).toEqual([]);
        expect((await reload(untouched.id))[field]).toEqual([other.id]);
        expect((await classificationRepository.getById(type, target.id)).archived).toBe(true);
      });
    });

    it('with no affected products just archives the classification', async () => {
      const cat = await makeClassification('category', 'Unused');
      const result = await service.removeWithFallback('category', cat.id);
      expect(result).toMatchObject({ status: 'completed', affectedCount: 0, updatedCount: 0 });
      expect((await classificationRepository.getById('category', cat.id)).archived).toBe(true);
    });

    it('works on an already-archived classification that products still reference', async () => {
      const cat = await makeClassification('category', 'Old');
      const p = await makeProduct({ categoryId: cat.id });
      await service.archive('category', cat.id);
      const result = await service.removeWithFallback('category', cat.id);
      expect(result.status).toBe('completed');
      expect((await reload(p.id)).categoryId).toBeNull();
    });

    it('queues a sync entry for the classification archive and for each product update', async () => {
      const cat = await makeClassification('category', 'Snacks');
      await makeProduct({ categoryId: cat.id });
      const productEntriesBefore = (await syncEntriesFor('product')).length;
      const categoryEntriesBefore = (await syncEntriesFor('category')).length;
      await service.removeWithFallback('category', cat.id);
      expect((await syncEntriesFor('product')).length).toBe(productEntriesBefore + 1);
      expect((await syncEntriesFor('category')).length).toBe(categoryEntriesBefore + 1);
    });

    describe('unsupported', () => {
      it('refuses unit removal and changes nothing', async () => {
        const unit = await makeClassification('unit', 'Kg');
        const p = await makeProduct({ unitId: unit.id });
        await expect(service.removeWithFallback('unit', unit.id)).rejects.toThrow(
          ClassificationRemovalNotSupportedError
        );
        expect((await classificationRepository.getById('unit', unit.id)).archived).toBe(false);
        expect((await reload(p.id)).unitId).toBe(unit.id);
      });

      it('throws for a missing classification', async () => {
        await expect(service.removeWithFallback('category', 'nope')).rejects.toThrow(ClassificationNotFoundError);
      });
    });

    describe('partial failure and retry', () => {
      async function setup() {
        const cat = await makeClassification('category', 'Snacks');
        const p1 = await makeProduct({ name: 'P1', categoryId: cat.id });
        const p2 = await makeProduct({ name: 'P2', categoryId: cat.id });
        const p3 = await makeProduct({ name: 'P3', categoryId: cat.id });
        return { cat, p1, p2, p3 };
      }

      /** Wrap the REAL productService so updateProduct fails for chosen ids. */
      function serviceWithFailingUpdate(failingIds, how = 'throw') {
        const flaky = {
          ...productService,
          updateProduct: async (existing, patch) => {
            if (failingIds.includes(existing.id)) {
              if (how === 'throw') throw new Error('disk full');
              return { product: existing, errors: ['Product needs a name or photo.'] };
            }
            return productService.updateProduct(existing, patch);
          }
        };
        return createClassificationService(classificationRepository, flaky);
      }

      it('keeps the classification ACTIVE, reports exactly what failed, and keeps successful updates', async () => {
        const { cat, p1, p2, p3 } = await setup();
        const result = await serviceWithFailingUpdate([p2.id]).removeWithFallback('category', cat.id);

        expect(result.status).toBe('partial');
        expect(result.retryable).toBe(true);
        expect(result.affectedCount).toBe(3);
        expect(result.updatedCount).toBe(2);
        expect(result.failures).toEqual([
          { productId: p2.id, productName: 'P2', message: 'disk full' }
        ]);
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(false);
        // not atomic, and honest about it: the others stay updated
        expect((await reload(p1.id)).categoryId).toBeNull();
        expect((await reload(p2.id)).categoryId).toBe(cat.id);
        expect((await reload(p3.id)).categoryId).toBeNull();
      });

      it('treats a validation error from updateProduct as a failure too', async () => {
        const { cat, p2 } = await setup();
        const result = await serviceWithFailingUpdate([p2.id], 'errors').removeWithFallback('category', cat.id);
        expect(result.status).toBe('partial');
        expect(result.failures[0]).toMatchObject({
          productId: p2.id,
          message: 'Product needs a name or photo.'
        });
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(false);
      });

      it('retry touches only what is still outstanding, then archives', async () => {
        const { cat, p1, p2, p3 } = await setup();
        await serviceWithFailingUpdate([p2.id]).removeWithFallback('category', cat.id);

        const productEntriesBeforeRetry = (await syncEntriesFor('product')).length;
        const retry = await service.removeWithFallback('category', cat.id);

        expect(retry).toMatchObject({
          status: 'completed',
          affectedCount: 1, // only P2 still references it
          updatedCount: 1,
          failures: [],
          retryable: false
        });
        expect((await reload(p2.id)).categoryId).toBeNull();
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(true);
        // P1 and P3 were not rewritten again
        expect((await syncEntriesFor('product')).length).toBe(productEntriesBeforeRetry + 1);
        expect((await reload(p1.id)).categoryId).toBeNull();
        expect((await reload(p3.id)).categoryId).toBeNull();
      });

      it('is idempotent: running a completed removal again changes nothing', async () => {
        const { cat } = await setup();
        await service.removeWithFallback('category', cat.id);
        const queued = await db.syncQueue.count();
        const again = await service.removeWithFallback('category', cat.id);
        expect(again).toMatchObject({ status: 'completed', affectedCount: 0, updatedCount: 0 });
        expect(await db.syncQueue.count()).toBe(queued);
      });

      it('reports archive-failed (classification still active) when only the archive step fails, and retry succeeds', async () => {
        const { cat, p1 } = await setup();
        let failNext = true;
        const flakyRepository = {
          ...classificationRepository,
          update: async (type, record) => {
            if (failNext) {
              failNext = false;
              throw new Error('storage unavailable');
            }
            return classificationRepository.update(type, record);
          }
        };
        const flakyService = createClassificationService(flakyRepository, productService);

        const result = await flakyService.removeWithFallback('category', cat.id);
        expect(result).toMatchObject({
          status: 'archive-failed',
          updatedCount: 3,
          failures: [],
          archiveError: 'storage unavailable',
          retryable: true
        });
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(false);
        expect((await reload(p1.id)).categoryId).toBeNull(); // products already done

        const retry = await flakyService.removeWithFallback('category', cat.id);
        expect(retry.status).toBe('completed');
        expect((await classificationRepository.getById('category', cat.id)).archived).toBe(true);
      });

      it('skips a product that was already fixed since the list was read', async () => {
        const cat = await makeClassification('category', 'Snacks');
        const p = await makeProduct({ categoryId: cat.id });
        // Simulate a concurrent fix: the fresh re-read no longer references it.
        const racing = {
          ...productService,
          getProduct: async (id) => ({ ...(await productService.getProduct(id)), categoryId: null })
        };
        const result = await createClassificationService(classificationRepository, racing).removeWithFallback(
          'category',
          cat.id
        );
        expect(result).toMatchObject({ status: 'completed', updatedCount: 0, skippedCount: 1 });
        expect(p.id).toBeTruthy();
      });
    });
  });
});
