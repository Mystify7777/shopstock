import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db/schema.js';
import {
  createClassificationRepository,
  UnknownEntityTypeError,
  ClassificationNotFoundError,
  InvalidClassificationError,
  UnrecognizedListOptionError,
} from './classificationRepository.js';
import { generateId } from '../../domain/shared/ids.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid classification object — caller-constructed, no factory.
 * Mirrors what a service would produce.
 */
function makeClassification(overrides = {}) {
  return {
    id:         generateId(),
    name:       'Test Classification',
    archived:   false,
    isDefault:  false,
    ...overrides,
  };
}

// All four valid entity types — used in parameterised coverage tests.
const ALL_ENTITY_TYPES = ['category', 'location', 'tag', 'unit'];

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe('classificationRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db   = createDatabase();
    repo = createClassificationRepository(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // =========================================================================
  // Unknown entity type — must fail before any DB access
  // =========================================================================

  describe('unknown entityType', () => {
    it('getById throws UnknownEntityTypeError', async () => {
      await expect(repo.getById('widget', 'any-id')).rejects.toThrow(UnknownEntityTypeError);
    });

    it('list throws UnknownEntityTypeError', async () => {
      await expect(repo.list('widget')).rejects.toThrow(UnknownEntityTypeError);
    });

    it('create throws UnknownEntityTypeError before touching the DB', async () => {
      const c = makeClassification();
      await expect(repo.create('widget', c)).rejects.toThrow(UnknownEntityTypeError);
      // Confirm nothing was written anywhere
      const allQueue = await db.syncQueue.toArray();
      expect(allQueue).toHaveLength(0);
    });

    it('update throws UnknownEntityTypeError before touching the DB', async () => {
      const c = makeClassification();
      await expect(repo.update('widget', c)).rejects.toThrow(UnknownEntityTypeError);
      const allQueue = await db.syncQueue.toArray();
      expect(allQueue).toHaveLength(0);
    });
  });

  // =========================================================================
  // All four entity types reachable
  // =========================================================================

  describe('all four entity types are reachable', () => {
    for (const entityType of ALL_ENTITY_TYPES) {
      it(`create + getById works for entityType="${entityType}"`, async () => {
        const c = makeClassification({ name: entityType + '-test' });
        await repo.create(entityType, c);
        const read = await repo.getById(entityType, c.id);
        expect(read).toMatchObject({ id: c.id, name: entityType + '-test' });
      });
    }
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe('getById', () => {
    it('returns undefined for an id that does not exist', async () => {
      const result = await repo.getById('category', 'nonexistent');
      expect(result).toBeUndefined();
    });

    it('returns the record after create', async () => {
      const c = makeClassification({ name: 'Snacks' });
      await repo.create('category', c);
      const result = await repo.getById('category', c.id);
      expect(result).toMatchObject({ id: c.id, name: 'Snacks' });
    });

    it('does not find a record stored under a different entity type', async () => {
      const c = makeClassification();
      await repo.create('category', c);
      const result = await repo.getById('location', c.id);
      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // list
  // =========================================================================

  describe('list', () => {
    it('returns empty array when no records exist', async () => {
      expect(await repo.list('category')).toEqual([]);
    });

    it('returns active records by default', async () => {
      const active = makeClassification({ name: 'Active' });
      await repo.create('tag', active);
      const results = await repo.list('tag');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(active.id);
    });

    it('excludes archived records by default', async () => {
      const c = makeClassification({ archived: true });
      await repo.create('location', c);
      const results = await repo.list('location');
      expect(results).toHaveLength(0);
    });

    it('includes archived records when includeArchived is true', async () => {
      const active   = makeClassification({ archived: false, name: 'Active' });
      const archived = makeClassification({ archived: true,  name: 'Archived' });
      await repo.create('unit', active);
      await repo.create('unit', archived);
      const results = await repo.list('unit', { includeArchived: true });
      expect(results).toHaveLength(2);
    });

    it('returns only active records when includeArchived is false explicitly', async () => {
      const active   = makeClassification({ archived: false });
      const archived = makeClassification({ archived: true });
      await repo.create('category', active);
      await repo.create('category', archived);
      const results = await repo.list('category', { includeArchived: false });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(active.id);
    });

    it('is scoped to the requested entity type', async () => {
      const cat = makeClassification({ name: 'Grocery' });
      const loc = makeClassification({ name: 'Shelf A' });
      await repo.create('category', cat);
      await repo.create('location', loc);
      const categories = await repo.list('category');
      expect(categories).toHaveLength(1);
      expect(categories[0].id).toBe(cat.id);
    });

    it('throws UnrecognizedListOptionError for unknown option keys', async () => {
      await expect(repo.list('category', { sort: 'name' }))
        .rejects.toThrow(UnrecognizedListOptionError);
    });

    it('throws UnrecognizedListOptionError even alongside a valid option', async () => {
      await expect(repo.list('category', { includeArchived: true, limit: 10 }))
        .rejects.toThrow(UnrecognizedListOptionError);
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  describe('create', () => {
    it('persists the classification so getById returns it', async () => {
      const c = makeClassification({ name: 'Beverages' });
      const result = await repo.create('category', c);
      expect(result).toBe(c);
      const read = await repo.getById('category', c.id);
      expect(read).toMatchObject({ id: c.id, name: 'Beverages' });
    });

    it('enqueues exactly one syncQueue entry', async () => {
      const c = makeClassification();
      await repo.create('category', c);
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(1);
    });

    it('syncQueue entry has correct shape', async () => {
      const c = makeClassification({ name: 'Cleaning' });
      await repo.create('category', c);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.entityType).toBe('category');
      expect(entry.operation).toBe('upsert');
      expect(entry.entityId).toBe(c.id);
      expect(entry.status).toBe('pending');
      expect(entry.attempts).toBe(0);
      expect(entry.lastError).toBeNull();
      expect(typeof entry.createdAt).toBe('string');
      expect(entry.createdAt.length).toBeGreaterThan(0);
      expect(entry.payload).toMatchObject({ id: c.id, name: 'Cleaning' });
    });

    it('entityId equals classification.id', async () => {
      const c = makeClassification();
      await repo.create('location', c);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.entityId).toBe(c.id);
    });

    it('clientId is not equal to classification.id (fresh per mutation)', async () => {
      const c = makeClassification();
      await repo.create('tag', c);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.clientId).not.toBe(c.id);
      expect(typeof entry.clientId).toBe('string');
      expect(entry.clientId.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe('update', () => {
    it('persists the updated classification', async () => {
      const c = makeClassification({ name: 'Original' });
      await repo.create('category', c);
      const updated = { ...c, name: 'Renamed' };
      await repo.update('category', updated);
      const read = await repo.getById('category', c.id);
      expect(read.name).toBe('Renamed');
    });

    it('returns the updated classification', async () => {
      const c = makeClassification();
      await repo.create('unit', c);
      const updated = { ...c, name: 'Kilogram' };
      const result = await repo.update('unit', updated);
      expect(result).toBe(updated);
    });

    it('can archive a classification via update', async () => {
      const c = makeClassification({ archived: false });
      await repo.create('tag', c);
      const archived = { ...c, archived: true };
      await repo.update('tag', archived);
      const read = await repo.getById('tag', c.id);
      expect(read.archived).toBe(true);
    });

    it('does not enforce isDefault — can archive a default', async () => {
      const c = makeClassification({ isDefault: true });
      await repo.create('category', c);
      const archived = { ...c, archived: true };
      await expect(repo.update('category', archived)).resolves.toBeDefined();
    });

    it('enqueues a syncQueue entry on update', async () => {
      const c = makeClassification();
      await repo.create('location', c);
      await db.syncQueue.clear();
      await repo.update('location', { ...c, name: 'Back Room' });
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe('upsert');
    });

    it('throws ClassificationNotFoundError when the row does not exist', async () => {
      const c = makeClassification();
      await expect(repo.update('category', c)).rejects.toThrow(ClassificationNotFoundError);
    });

    it('throws InvalidClassificationError for null input', async () => {
      await expect(repo.update('category', null)).rejects.toThrow(InvalidClassificationError);
    });

    it('throws InvalidClassificationError for undefined input', async () => {
      await expect(repo.update('category', undefined)).rejects.toThrow(InvalidClassificationError);
    });

    it('throws InvalidClassificationError for non-object input', async () => {
      await expect(repo.update('category', 'a-string')).rejects.toThrow(InvalidClassificationError);
    });

    it('entityType is validated before classification shape — UnknownEntityTypeError wins', async () => {
      await expect(repo.update('widget', null)).rejects.toThrow(UnknownEntityTypeError);
    });
  });

  // =========================================================================
  // clientId semantics
  // =========================================================================

  describe('clientId semantics', () => {
    it('two mutations to the same classification have the same entityId but different clientIds', async () => {
      const c = makeClassification({ name: 'V1' });
      await repo.create('category', c);
      await db.syncQueue.clear();

      await repo.update('category', { ...c, name: 'V2' });
      await repo.update('category', { ...c, name: 'V3' });

      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(2);
      expect(entries[0].entityId).toBe(c.id);
      expect(entries[1].entityId).toBe(c.id);      // same entity
      expect(entries[0].clientId).not.toBe(entries[1].clientId); // different mutations
    });

    it('create clientId differs from update clientId for the same classification', async () => {
      const c = makeClassification();
      await repo.create('tag', c);
      const createEntry = (await db.syncQueue.toArray())[0];
      await db.syncQueue.clear();

      await repo.update('tag', { ...c, name: 'Updated' });
      const updateEntry = (await db.syncQueue.toArray())[0];

      expect(createEntry.entityId).toBe(c.id);
      expect(updateEntry.entityId).toBe(c.id);
      expect(createEntry.clientId).not.toBe(updateEntry.clientId);
    });
  });

  // =========================================================================
  // Atomicity — rollback tests
  //
  // Strategy: monkey-patch the syncQueue.add to throw after the classification
  // write, then assert the classification write was rolled back too.
  // Mirrors the productRepository atomicity test approach.
  // =========================================================================

  describe('atomicity — create()', () => {
    it('rolls back the classification write if syncQueue.add fails', async () => {
      const c = makeClassification({ name: 'Atomic Create' });

      const originalAdd = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async () => {
        throw new Error('forced syncQueue failure');
      };

      await expect(repo.create('category', c)).rejects.toThrow('forced syncQueue failure');

      db.syncQueue.add = originalAdd;

      // Classification must not have been committed
      const stored = await db.categories.get(c.id);
      expect(stored).toBeUndefined();

      // No orphaned queue entry
      const queue = await db.syncQueue.toArray();
      expect(queue).toHaveLength(0);
    });
  });

  describe('atomicity — update()', () => {
    it('rolls back the classification put if syncQueue.add fails', async () => {
      const c = makeClassification({ name: 'Original Name' });
      await repo.create('category', c);
      await db.syncQueue.clear();

      const originalAdd = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async () => {
        throw new Error('forced syncQueue failure on update');
      };

      await expect(
        repo.update('category', { ...c, name: 'Changed Name' })
      ).rejects.toThrow('forced syncQueue failure on update');

      db.syncQueue.add = originalAdd;

      // Original name must still be stored
      const stored = await db.categories.get(c.id);
      expect(stored.name).toBe('Original Name');

      // No queue entry from the failed update
      const queue = await db.syncQueue.toArray();
      expect(queue).toHaveLength(0);
    });
  });
});
