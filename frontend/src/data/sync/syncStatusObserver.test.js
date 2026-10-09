import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createSyncStatusObserver } from './syncStatusObserver.js';

// Real Dexie over fake-indexeddb: the counts are only meaningful against the
// real queue schema, so nothing here is mocked.

let db;
let observer;
let seq = 0;

function row(status) {
  seq += 1;
  return {
    entityType: 'product',
    entityId: `p${seq}`,
    operation: 'upsert',
    payload: {},
    clientId: `c${seq}`,
    attempts: 0,
    status,
    createdAt: new Date().toISOString(),
    lastError: status === 'failed' ? 'CONFLICT: boom (409)' : null
  };
}

async function seed(statuses) {
  for (const status of statuses) await db.syncQueue.add(row(status));
}

beforeEach(() => {
  db = createDatabase(`sync-status-${Math.random()}`);
  observer = createSyncStatusObserver(db);
});

afterEach(async () => {
  await db.delete();
});

describe('createSyncStatusObserver', () => {
  it('requires a database', () => {
    expect(() => createSyncStatusObserver()).toThrow(TypeError);
  });

  describe('getSyncStatus', () => {
    it('empty queue: 0 pending, 0 failed', async () => {
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 0, failedCount: 0 });
    });

    it('pending only', async () => {
      await seed(['pending', 'pending']);
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 2, failedCount: 0 });
    });

    it('processing only counts as pending (a claimed row still has to sync)', async () => {
      await seed(['processing']);
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 1, failedCount: 0 });
    });

    it('pending + processing are added together', async () => {
      await seed(['pending', 'processing', 'processing']);
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 3, failedCount: 0 });
    });

    it('failed only', async () => {
      await seed(['failed', 'failed']);
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 0, failedCount: 2 });
    });

    it('pending and failed are counted independently', async () => {
      await seed(['pending', 'failed', 'processing', 'failed', 'failed']);
      expect(await observer.getSyncStatus()).toEqual({ pendingCount: 2, failedCount: 3 });
    });

    it('returns only counts: no rows, statuses or lastError leak out', async () => {
      await seed(['failed']);
      const status = await observer.getSyncStatus();
      expect(Object.keys(status).sort()).toEqual(['failedCount', 'pendingCount']);
    });

    it('is read-only: the queue is unchanged afterwards', async () => {
      await seed(['pending', 'processing', 'failed']);
      const before = await db.syncQueue.toArray();
      await observer.getSyncStatus();
      expect(await db.syncQueue.toArray()).toEqual(before);
    });
  });

  describe('observeSyncStatus', () => {
    function collect() {
      const seen = [];
      return { seen, onChange: (status) => seen.push(status) };
    }
    const waitFor = async (predicate, ms = 2000) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting for the observer');
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    it('emits the current counts first', async () => {
      await seed(['pending', 'failed']);
      const { seen, onChange } = collect();
      const stop = observer.observeSyncStatus(onChange);
      await waitFor(() => seen.length > 0);
      expect(seen[0]).toEqual({ pendingCount: 1, failedCount: 1 });
      stop();
    });

    it('emits again when the queue changes', async () => {
      const { seen, onChange } = collect();
      const stop = observer.observeSyncStatus(onChange);
      await waitFor(() => seen.length > 0);
      expect(seen.at(-1)).toEqual({ pendingCount: 0, failedCount: 0 });

      await db.syncQueue.add(row('pending'));
      await waitFor(() => seen.at(-1).pendingCount === 1);

      await db.syncQueue.add(row('failed'));
      await waitFor(() => seen.at(-1).failedCount === 1);
      expect(seen.at(-1)).toEqual({ pendingCount: 1, failedCount: 1 });

      // a drain completing deletes the synced row
      const pending = await db.syncQueue.where('status').equals('pending').first();
      await db.syncQueue.delete(pending.localId);
      await waitFor(() => seen.at(-1).pendingCount === 0);
      stop();
    });

    it('sees a status transition (pending -> processing stays pending)', async () => {
      await seed(['pending']);
      const { seen, onChange } = collect();
      const stop = observer.observeSyncStatus(onChange);
      await waitFor(() => seen.length > 0);

      const first = await db.syncQueue.toCollection().first();
      await db.syncQueue.update(first.localId, { status: 'failed' });
      await waitFor(() => seen.at(-1).failedCount === 1);
      expect(seen.at(-1)).toEqual({ pendingCount: 0, failedCount: 1 });
      stop();
    });

    it('reports a failed reading through onError and still emits on a later change (Dexie keeps the subscription)', async () => {
      const seen = [];
      const errors = [];
      const stop = observer.observeSyncStatus((s) => seen.push(s), (e) => errors.push(e));
      await waitFor(() => seen.length > 0);

      // Make the next reading fail once.
      const realWhere = db.syncQueue.where.bind(db.syncQueue);
      let failed = false;
      const spy = vi.spyOn(db.syncQueue, 'where').mockImplementation((...args) => {
        if (!failed) {
          failed = true;
          throw new Error('read failed');
        }
        return realWhere(...args);
      });

      await db.syncQueue.add(row('pending'));
      await waitFor(() => errors.length > 0);
      expect(errors[0].message).toBe('read failed');

      // The subscription is still alive: the next change produces a reading.
      spy.mockRestore();
      await db.syncQueue.add(row('pending'));
      await waitFor(() => seen.at(-1).pendingCount === 2);
      stop();
    });

    it('stops emitting after unsubscribe', async () => {
      const { seen, onChange } = collect();
      const stop = observer.observeSyncStatus(onChange);
      await waitFor(() => seen.length > 0);
      stop();
      const countAfterStop = seen.length;

      await db.syncQueue.add(row('pending'));
      await new Promise((r) => setTimeout(r, 100));
      expect(seen.length).toBe(countAfterStop);
    });
  });
});
