import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createSyncQueueLifecycle } from './syncQueueLifecycle.js';
import { createSyncDrainer } from './syncDrainer.js';
import { SYNC_OUTCOME } from './syncEntryExecutor.js';
import { ApiRequestError, ApiNetworkError } from '../../auth/apiClient.js';
import { AuthApiError, AuthNetworkError } from '../../auth/authClient.js';

describe('syncDrainer', () => {
  let db;
  let syncQueueLifecycle;

  beforeEach(() => {
    db = createDatabase();
    syncQueueLifecycle = createSyncQueueLifecycle(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  function seedEntry(overrides = {}) {
    const { entityId: shortId, ...rest } = overrides;
    return db.syncQueue.add({
      entityType: 'category',
      operation: 'upsert',
      entityId: `cat-${shortId ?? '1'}`,
      clientId: 'client-1',
      payload: { id: 'cat-1', name: 'Snacks' },
      attempts: 0,
      status: 'pending',
      createdAt: '2026-09-11T10:00:00.000Z',
      lastError: null,
      ...rest,
    });
  }

  function makeMockExecutor(outcomesByEntityId) {
    // outcomesByEntityId: { [entityId]: outcome | outcome[] }
    // A single outcome is returned every time; an array is consumed
    // one-per-call (useful for the "same entry retried across drains"
    // scenario).
    const callCounts = {};
    return {
      executeSyncEntry: vi.fn(async (entry) => {
        const spec = outcomesByEntityId[entry.entityId];
        if (Array.isArray(spec)) {
          const i = callCounts[entry.entityId] ?? 0;
          callCounts[entry.entityId] = i + 1;
          return spec[Math.min(i, spec.length - 1)];
        }
        return spec;
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('createSyncDrainer', () => {
    it('throws if syncQueueLifecycle is missing', () => {
      expect(() => createSyncDrainer({ syncEntryExecutor: {} })).toThrow(TypeError);
    });

    it('throws if syncEntryExecutor is missing', () => {
      expect(() => createSyncDrainer({ syncQueueLifecycle })).toThrow(TypeError);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty queue
  // ---------------------------------------------------------------------------

  describe('empty queue', () => {
    it('resolves with all-zero result and no stop reason', async () => {
      const syncEntryExecutor = makeMockExecutor({});
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result).toEqual({ processed: 0, failed: 0, stopped: false, reason: null });
    });

    it('does not call executeSyncEntry at all', async () => {
      const syncEntryExecutor = makeMockExecutor({});
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();

      expect(syncEntryExecutor.executeSyncEntry).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Success path — FIFO order, delete on success
  // ---------------------------------------------------------------------------

  describe('successful entries', () => {
    it('processes a single successful entry: deletes it, processed: 1', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.SUCCESS, response: { ok: true } },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result).toEqual({ processed: 1, failed: 0, stopped: false, reason: null });
      expect(await db.syncQueue.toArray()).toEqual([]);
    });

    it('processes multiple entries in strict FIFO order by localId', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });
      await seedEntry({ entityId: 'c' });

      const callOrder = [];
      const syncEntryExecutor = {
        executeSyncEntry: vi.fn(async (entry) => {
          callOrder.push(entry.entityId);
          return { kind: SYNC_OUTCOME.SUCCESS, response: {} };
        }),
      };
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(callOrder).toEqual(['cat-a', 'cat-b', 'cat-c']);
      expect(result.processed).toBe(3);
    });

    it('never calls executeSyncEntry concurrently -- one entry fully resolves before the next is claimed', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });

      let concurrentCalls = 0;
      let maxConcurrent = 0;
      const syncEntryExecutor = {
        executeSyncEntry: vi.fn(async () => {
          concurrentCalls += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrentCalls -= 1;
          return { kind: SYNC_OUTCOME.SUCCESS, response: {} };
        }),
      };
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();

      expect(maxConcurrent).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Permanent failure — mark failed, continue draining
  // ---------------------------------------------------------------------------

  describe('permanent failure', () => {
    it('marks the entry failed with the formatted lastError, and continues to the next entry', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });

      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'Bad request.', 400) },
        'cat-b': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result).toEqual({ processed: 1, failed: 1, stopped: false, reason: null });

      const remaining = await db.syncQueue.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('failed');
      expect(remaining[0].lastError).toBe('VALIDATION_ERROR: Bad request. (400)');
    });

    it('a failed entry is retained, not deleted', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('NOT_FOUND', 'x', 404) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();

      const remaining = await db.syncQueue.toArray();
      expect(remaining).toHaveLength(1);
    });

    it('a failed entry is not reclaimed by a subsequent drain (excluded from automatic processing)', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('NOT_FOUND', 'x', 404) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();
      const secondResult = await drainer.drain();

      expect(secondResult).toEqual({ processed: 0, failed: 0, stopped: false, reason: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Transient/auth failure — stop drain, entry stays pending (via recovery)
  // ---------------------------------------------------------------------------

  describe('transient failure stops the drain', () => {
    it('ApiNetworkError stops the drain with the correct reason', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });

      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_NETWORK_ERROR, error: new ApiNetworkError(new Error('offline')) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result).toEqual({ processed: 0, failed: 0, stopped: true, reason: 'apiNetworkError' });
    });

    it('does not process later entries after a stop', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });

      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_NETWORK_ERROR, error: new ApiNetworkError(new Error('offline')) },
        'cat-b': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();

      expect(syncEntryExecutor.executeSyncEntry).toHaveBeenCalledTimes(1);
    });

    it('the stopped entry remains in the database as processing (not reset within the same drain)', async () => {
      const localId = await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.AUTH_NETWORK_ERROR, error: new AuthNetworkError(new Error('offline')) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await drainer.drain();

      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');
    });

    it('a subsequent drain recovers the stopped entry back to pending and retries it', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        // First drain: stops. Second drain: recovers + succeeds.
        'cat-a': [
          { kind: SYNC_OUTCOME.AUTH_NETWORK_ERROR, error: new AuthNetworkError(new Error('offline')) },
          { kind: SYNC_OUTCOME.SUCCESS, response: {} },
        ],
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const first = await drainer.drain();
      expect(first.stopped).toBe(true);

      const second = await drainer.drain();
      expect(second).toEqual({ processed: 1, failed: 0, stopped: false, reason: null });
      expect(await db.syncQueue.toArray()).toEqual([]);
    });

    it('AuthApiError stops the drain with reason authError', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.AUTH_ERROR, error: new AuthApiError('UNAUTHORIZED', 'x', 401) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('authError');
    });

    it('a transient 5xx ApiRequestError stops the drain with reason transientApiError', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('INTERNAL_ERROR', 'x', 500) },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('transientApiError');
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery — once per actual drain, not once per drain() call
  // ---------------------------------------------------------------------------

  describe('crash recovery integration', () => {
    it('a stale processing row from a previous run is recovered and processed on the next drain', async () => {
      const localId = await seedEntry({ entityId: 'a', status: 'processing' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const result = await drainer.drain();

      expect(result.processed).toBe(1);
      expect(await db.syncQueue.get(localId)).toBeUndefined();
    });

    it('a joined (single-flight) drain call does not trigger a second recovery pass', async () => {
      await seedEntry({ entityId: 'a', status: 'processing' });

      let recoverCallCount = 0;
      const realRecover = syncQueueLifecycle.recoverStaleProcessingEntries.bind(syncQueueLifecycle);
      const spiedLifecycle = {
        ...syncQueueLifecycle,
        recoverStaleProcessingEntries: vi.fn(async () => {
          recoverCallCount += 1;
          return realRecover();
        }),
      };

      let resolveExecute;
      const syncEntryExecutor = {
        executeSyncEntry: vi.fn(() => new Promise((resolve) => { resolveExecute = resolve; })),
      };
      const drainer = createSyncDrainer({ syncQueueLifecycle: spiedLifecycle, syncEntryExecutor });

      const p1 = drainer.drain();
      const p2 = drainer.drain(); // joins the same in-flight drain

      // The internal chain (recovery -> claim -> execute) is all
      // awaited/microtask-scheduled -- resolveExecute is only assigned
      // once executeSyncEntry() actually runs, not synchronously when
      // drain() is called. Wait for that to happen before resolving.
      await vi.waitFor(() => expect(resolveExecute).toBeInstanceOf(Function));

      resolveExecute({ kind: SYNC_OUTCOME.SUCCESS, response: {} });
      await Promise.all([p1, p2]);

      expect(recoverCallCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Single-flight concurrent-drain guard
  // ---------------------------------------------------------------------------

  describe('single-flight concurrent drain guard', () => {
    it('concurrent drain() calls share exactly one actual drain execution', async () => {
      await seedEntry({ entityId: 'a' });
      await seedEntry({ entityId: 'b' });

      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
        'cat-b': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const p1 = drainer.drain();
      const p2 = drainer.drain();
      const p3 = drainer.drain();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // All three callers see the SAME result -- one drain, not three.
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
      expect(r1.processed).toBe(2);
    });

    it('a new drain() call after the previous one settles starts a genuinely new execution', async () => {
      await seedEntry({ entityId: 'a' });
      const syncEntryExecutor = makeMockExecutor({
        'cat-a': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
        'cat-b': { kind: SYNC_OUTCOME.SUCCESS, response: {} },
      });
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      const first = await drainer.drain();
      expect(first.processed).toBe(1);

      // 'b' did not exist during the first drain -- it's seeded only
      // now, after the first drain fully settled. If drain() only ever
      // returned a cached/stale promise, this second call would still
      // reflect the FIRST drain's already-empty-queue result (0
      // processed) rather than genuinely re-running the loop and
      // discovering 'b'.
      await seedEntry({ entityId: 'b' });
      const second = await drainer.drain();

      expect(second.processed).toBe(1);
      expect(second).not.toBe(first);
    });
  });

  // ---------------------------------------------------------------------------
  // Unexpected programmer error — propagates, is not reinterpreted
  // ---------------------------------------------------------------------------

  describe('unexpected errors propagate rather than being reinterpreted as policy', () => {
    it('an error thrown by executeSyncEntry (outside the four documented kinds) rejects drain()', async () => {
      const localId = await seedEntry({ entityId: 'a' });
      const bug = new TypeError('something unrelated broke');
      const syncEntryExecutor = {
        executeSyncEntry: vi.fn().mockRejectedValue(bug),
      };
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await expect(drainer.drain()).rejects.toBe(bug);

      // The entry remains 'processing' -- not reset, not marked failed,
      // not deleted. A later drain's recovery pass will reclaim it.
      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');
    });

    it('after a rejected drain, a subsequent drain call starts fresh (not stuck on the old rejected promise)', async () => {
      await seedEntry({ entityId: 'a' });
      const bug = new Error('boom');
      let shouldThrow = true;
      const syncEntryExecutor = {
        executeSyncEntry: vi.fn(async () => {
          if (shouldThrow) {
            shouldThrow = false;
            throw bug;
          }
          return { kind: SYNC_OUTCOME.SUCCESS, response: {} };
        }),
      };
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

      await expect(drainer.drain()).rejects.toBe(bug);

      const result = await drainer.drain();
      expect(result.processed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope boundary
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not expose any retry/backoff/timer configuration', () => {
      const syncEntryExecutor = makeMockExecutor({});
      const drainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });
      expect(drainer.retry).toBeUndefined();
      expect(drainer.setBackoff).toBeUndefined();
      expect(drainer.startPolling).toBeUndefined();
    });
  });
});
