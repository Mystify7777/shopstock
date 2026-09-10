import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createSyncQueueLifecycle } from './syncQueueLifecycle.js';

describe('syncQueueLifecycle', () => {
  let db;
  let lifecycle;

  beforeEach(() => {
    db = createDatabase();
    lifecycle = createSyncQueueLifecycle(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  function seedEntry(overrides = {}) {
    return db.syncQueue.add({
      entityType: 'category',
      operation: 'upsert',
      entityId: 'cat-1',
      clientId: 'client-1',
      payload: { id: 'cat-1', name: 'Snacks' },
      attempts: 0,
      status: 'pending',
      createdAt: '2026-09-10T10:00:00.000Z',
      lastError: null,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // claimNextPending
  // ---------------------------------------------------------------------------

  describe('claimNextPending', () => {
    it('returns null when the queue is empty', async () => {
      const claimed = await lifecycle.claimNextPending();
      expect(claimed).toBeNull();
    });

    it('returns null when every entry is already processing or failed', async () => {
      await seedEntry({ status: 'processing' });
      await seedEntry({ status: 'failed', lastError: 'x' });
      const claimed = await lifecycle.claimNextPending();
      expect(claimed).toBeNull();
    });

    it('claims the oldest pending entry, by localId order', async () => {
      const idA = await seedEntry({ entityId: 'cat-1' });
      const idB = await seedEntry({ entityId: 'cat-2' });
      const claimed = await lifecycle.claimNextPending();
      expect(claimed.localId).toBe(idA);
      expect(claimed.entityId).toBe('cat-1');
      // The second entry must remain untouched.
      const second = await db.syncQueue.get(idB);
      expect(second.status).toBe('pending');
    });

    it('marks the claimed entry as processing in the database', async () => {
      const localId = await seedEntry();
      await lifecycle.claimNextPending();
      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');
    });

    it('returns the claimed entry reflecting the processing status', async () => {
      await seedEntry();
      const claimed = await lifecycle.claimNextPending();
      expect(claimed.status).toBe('processing');
    });

    it('skips entries already in processing or failed, claiming the oldest genuinely pending one', async () => {
      await seedEntry({ entityId: 'already-processing', status: 'processing' });
      await seedEntry({ entityId: 'already-failed', status: 'failed', lastError: 'x' });
      const pendingId = await seedEntry({ entityId: 'genuinely-pending' });

      const claimed = await lifecycle.claimNextPending();
      expect(claimed.localId).toBe(pendingId);
      expect(claimed.entityId).toBe('genuinely-pending');
    });

    it('a second claim after the first does not reclaim the same entry', async () => {
      const idA = await seedEntry({ entityId: 'cat-1' });
      const idB = await seedEntry({ entityId: 'cat-2' });

      const first = await lifecycle.claimNextPending();
      const second = await lifecycle.claimNextPending();

      expect(first.localId).toBe(idA);
      expect(second.localId).toBe(idB);
    });

    it('preserves every other field on the claimed entry unchanged', async () => {
      await seedEntry({
        entityType: 'stockEvent',
        operation: 'insert',
        entityId: 'evt-1',
        clientId: 'evt-1',
        payload: { id: 'evt-1', quantity: 5 },
        attempts: 2,
      });
      const claimed = await lifecycle.claimNextPending();
      expect(claimed.entityType).toBe('stockEvent');
      expect(claimed.operation).toBe('insert');
      expect(claimed.entityId).toBe('evt-1');
      expect(claimed.clientId).toBe('evt-1');
      expect(claimed.payload).toEqual({ id: 'evt-1', quantity: 5 });
      expect(claimed.attempts).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // markSucceeded
  // ---------------------------------------------------------------------------

  describe('markSucceeded', () => {
    it('deletes the queue row entirely', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.markSucceeded(localId);
      const stored = await db.syncQueue.get(localId);
      expect(stored).toBeUndefined();
    });

    it('does not leave any status behind -- the row is gone, not marked done', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.markSucceeded(localId);
      const all = await db.syncQueue.toArray();
      expect(all).toEqual([]);
    });

    it('is safe to call on an already-absent localId', async () => {
      await expect(lifecycle.markSucceeded(999999)).resolves.not.toThrow();
    });

    it('only removes the specified entry, leaving others untouched', async () => {
      const idA = await seedEntry({ entityId: 'cat-1', status: 'processing' });
      const idB = await seedEntry({ entityId: 'cat-2' });
      await lifecycle.markSucceeded(idA);
      const remaining = await db.syncQueue.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].localId).toBe(idB);
    });
  });

  // ---------------------------------------------------------------------------
  // markFailed
  // ---------------------------------------------------------------------------

  describe('markFailed', () => {
    it('sets status to failed', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.markFailed(localId, 'VALIDATION_ERROR: Bad request (400)');
      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('failed');
    });

    it('records the exact lastError string given', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.markFailed(localId, 'VALIDATION_ERROR: Bad request (400)');
      const stored = await db.syncQueue.get(localId);
      expect(stored.lastError).toBe('VALIDATION_ERROR: Bad request (400)');
    });

    it('retains the row -- a failed entry is never deleted', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.markFailed(localId, 'x');
      const stored = await db.syncQueue.get(localId);
      expect(stored).toBeDefined();
    });

    it('preserves every other field on the entry unchanged', async () => {
      const localId = await seedEntry({ entityId: 'cat-1', payload: { id: 'cat-1', name: 'Snacks' } });
      await lifecycle.markFailed(localId, 'x');
      const stored = await db.syncQueue.get(localId);
      expect(stored.entityId).toBe('cat-1');
      expect(stored.payload).toEqual({ id: 'cat-1', name: 'Snacks' });
    });

    it('throws for a non-string lastError', async () => {
      const localId = await seedEntry();
      await expect(lifecycle.markFailed(localId, null)).rejects.toThrow(TypeError);
      await expect(lifecycle.markFailed(localId, 42)).rejects.toThrow(TypeError);
      await expect(lifecycle.markFailed(localId, undefined)).rejects.toThrow(TypeError);
    });

    it('throws for an empty-string lastError', async () => {
      const localId = await seedEntry();
      await expect(lifecycle.markFailed(localId, '')).rejects.toThrow(TypeError);
    });

    it('rejecting an invalid lastError does not modify the entry', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await expect(lifecycle.markFailed(localId, '')).rejects.toThrow(TypeError);
      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');
      expect(stored.lastError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // recoverStaleProcessingEntries
  // ---------------------------------------------------------------------------

  describe('recoverStaleProcessingEntries', () => {
    it('returns 0 when there are no processing entries', async () => {
      await seedEntry({ status: 'pending' });
      await seedEntry({ status: 'failed', lastError: 'x' });
      const count = await lifecycle.recoverStaleProcessingEntries();
      expect(count).toBe(0);
    });

    it('resets a single stale processing entry to pending', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.recoverStaleProcessingEntries();
      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('pending');
    });

    it('resets multiple stale processing entries', async () => {
      const idA = await seedEntry({ entityId: 'a', status: 'processing' });
      const idB = await seedEntry({ entityId: 'b', status: 'processing' });
      const idC = await seedEntry({ entityId: 'c', status: 'pending' });

      const count = await lifecycle.recoverStaleProcessingEntries();

      expect(count).toBe(2);
      expect((await db.syncQueue.get(idA)).status).toBe('pending');
      expect((await db.syncQueue.get(idB)).status).toBe('pending');
      expect((await db.syncQueue.get(idC)).status).toBe('pending'); // was already pending, untouched
    });

    it('does not touch pending or failed entries', async () => {
      const pendingId = await seedEntry({ entityId: 'p', status: 'pending' });
      const failedId = await seedEntry({ entityId: 'f', status: 'failed', lastError: 'x' });
      await seedEntry({ entityId: 'proc', status: 'processing' });

      await lifecycle.recoverStaleProcessingEntries();

      expect((await db.syncQueue.get(pendingId)).status).toBe('pending');
      const failedEntry = await db.syncQueue.get(failedId);
      expect(failedEntry.status).toBe('failed');
      expect(failedEntry.lastError).toBe('x');
    });

    it('preserves every other field on recovered entries unchanged', async () => {
      const localId = await seedEntry({
        entityId: 'evt-1',
        payload: { id: 'evt-1', quantity: 5 },
        attempts: 1,
        status: 'processing',
      });
      await lifecycle.recoverStaleProcessingEntries();
      const stored = await db.syncQueue.get(localId);
      expect(stored.entityId).toBe('evt-1');
      expect(stored.payload).toEqual({ id: 'evt-1', quantity: 5 });
      expect(stored.attempts).toBe(1);
    });

    it('a recovered entry becomes claimable again via claimNextPending', async () => {
      const localId = await seedEntry({ status: 'processing' });
      await lifecycle.recoverStaleProcessingEntries();
      const claimed = await lifecycle.claimNextPending();
      expect(claimed.localId).toBe(localId);
      expect(claimed.status).toBe('processing');
    });
  });

  // ---------------------------------------------------------------------------
  // Scope boundary
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not expose any HTTP/network method', () => {
      expect(lifecycle.drain).toBeUndefined();
      expect(lifecycle.request).toBeUndefined();
      expect(lifecycle.send).toBeUndefined();
    });
  });
});
