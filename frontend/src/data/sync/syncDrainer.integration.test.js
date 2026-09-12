// 6C-5 — Full-chain integration verification.
//
// Every module in this test is the REAL production module, wired
// exactly as the composition root (main.jsx) wires it. Only the actual
// network boundary -- global fetch -- is mocked, which is the correct
// place to keep "the backend boundary controlled": we are proving that
// ShopStock's own code composes correctly, not re-testing the real
// Phase 5 backend (that's the backend's own test suite's job).
//
// Chain under test:
//
//   real Dexie syncQueue
//     -> real syncQueueLifecycle   (claim / mark / recover)
//     -> real syncEntryExecutor    (createSyncRequest + apiClient.request)
//     -> real createSyncRequest    (wire serialization -- 6A)
//     -> real apiClient            (token attachment, 401 recovery -- 6B2-d)
//     -> real authManager          (single-flight refresh -- 6B2-c)
//     -> real authClient           (HTTP shape for /login /refresh -- 6B2-b)
//     -> [mocked fetch]
//     -> real syncFailureClassifier (policy -- 6C-3)
//     -> real syncDrainer           (the loop -- 6C-4)
//
// No module here is mocked except fetch itself. Every other test file
// in this project mocks its immediate dependency; this file exists
// specifically to prove the seams between them are real, not merely
// individually well-tested in isolation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createSyncQueueLifecycle } from './syncQueueLifecycle.js';
import { createSyncEntryExecutor } from './syncEntryExecutor.js';
import { createSyncDrainer } from './syncDrainer.js';
import { createSessionStore } from '../../auth/sessionStore.js';
import { createAuthClient } from '../../auth/authClient.js';
import { createAuthManager } from '../../auth/authManager.js';
import { createApiClient } from '../../auth/apiClient.js';

const BASE_URL = 'https://api.example.com';

// ---------------------------------------------------------------------------
// fetch mocking -- the one and only mocked boundary in this file
// ---------------------------------------------------------------------------

/**
 * Install a queue of canned fetch responses, consumed in order. Each
 * spec is { status, body }. Optionally asserts on the request as it's
 * consumed, via an `onRequest` callback, so tests can verify exactly
 * what the real chain sent to the real network boundary.
 */
function mockFetchQueue(specs, { onRequest } = {}) {
  let i = 0;
  global.fetch = vi.fn(async (url, init) => {
    const spec = specs[Math.min(i, specs.length - 1)];
    i += 1;
    if (onRequest) onRequest(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: () => Promise.resolve(spec.body),
    };
  });
}

describe('6C-5 full-chain integration', () => {
  let db;
  let chain;

  beforeEach(async () => {
    db = createDatabase();

    const sessionStore = createSessionStore(db);
    const authClient = createAuthClient(BASE_URL);
    const authManager = createAuthManager({ sessionStore, authClient });
    const apiClient = createApiClient({ authManager, baseUrl: BASE_URL });
    const syncQueueLifecycle = createSyncQueueLifecycle(db);
    const syncEntryExecutor = createSyncEntryExecutor({ apiClient });
    const syncDrainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

    // A valid, already-authenticated session -- most scenarios below
    // don't exercise login itself (that's authManager.test.js's job);
    // they exercise what happens to already-in-flight sync traffic.
    await sessionStore.setRefreshToken('valid-refresh-token');

    chain = { db, sessionStore, authManager, syncQueueLifecycle, syncDrainer };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete global.fetch;
    if (db.isOpen()) db.close();
    await db.delete();
  });

  function seedQueueEntry(overrides = {}) {
    return db.syncQueue.add({
      entityType: 'category',
      operation: 'upsert',
      entityId: 'cat-1',
      clientId: 'client-1',
      payload: { id: 'cat-1', name: 'Snacks', archived: false, isDefault: false },
      attempts: 0,
      status: 'pending',
      createdAt: '2026-09-12T10:00:00.000Z',
      lastError: null,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Happy path — real wire request reaches the mocked network boundary
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    it('a real category entry reaches fetch with the correct method/path/body and is deleted on success', async () => {
      await seedQueueEntry();

      let capturedUrl, capturedInit;
      mockFetchQueue(
        [{ status: 200, body: { id: 'cat-1', name: 'Snacks' } }],
        { onRequest: (url, init) => { capturedUrl = url; capturedInit = init; } }
      );

      const result = await chain.syncDrainer.drain();

      expect(result).toEqual({ processed: 1, failed: 0, stopped: false, reason: null });
      expect(capturedUrl).toBe('https://api.example.com/api/categories/cat-1');
      expect(capturedInit.method).toBe('PUT');
      expect(JSON.parse(capturedInit.body)).toEqual({
        id: 'cat-1', name: 'Snacks', archived: false, isDefault: false,
      });
      expect(await db.syncQueue.toArray()).toEqual([]);
    });

    it('the real Authorization header carries the current access token', async () => {
      await seedQueueEntry();

      let capturedInit;
      // First fetch call is authManager.restoreSession()'s own
      // POST /api/auth/refresh; the second is the actual sync PUT.
      mockFetchQueue(
        [
          { status: 200, body: { accessToken: 'access-1', refreshToken: 'refresh-2' } },
          { status: 200, body: { id: 'cat-1' } },
        ],
        { onRequest: (url, init) => { if (url.includes('/api/categories')) capturedInit = init; } }
      );

      await chain.authManager.restoreSession(); // populates the in-memory access token via a real refresh
      await chain.syncDrainer.drain();

      expect(capturedInit.headers.Authorization).toBe('Bearer access-1');
    });

    it('mixed entity types in one drain all serialize correctly through the real wire seam', async () => {
      // One of each family: a classification (no stripping needed), a
      // product (quantity must be stripped), a stockEvent
      // (appliedQuantity stripped, expectedCurrentQuantity preserved),
      // and a productChangeEvent (accepted stripped). This is the
      // strongest proof that 6A's wire-contract fixes and 6C's drain
      // are genuinely composed, not just individually correct.
      await seedQueueEntry();

      await db.syncQueue.add({
        entityType: 'product',
        operation: 'upsert',
        entityId: 'prod-1',
        clientId: 'client-2',
        payload: { id: 'prod-1', name: 'Parle-G', quantity: 42, archived: false },
        attempts: 0, status: 'pending', createdAt: '2026-09-12T10:00:01.000Z', lastError: null,
      });

      await db.syncQueue.add({
        entityType: 'stockEvent',
        operation: 'insert',
        entityId: 'evt-1',
        clientId: 'evt-1',
        payload: {
          id: 'evt-1', productId: 'prod-1', type: 'ADD', quantity: 5,
          recordedAt: '2026-09-12T10:00:02.000Z',
          expectedCurrentQuantity: 10, appliedQuantity: 5,
        },
        attempts: 0, status: 'pending', createdAt: '2026-09-12T10:00:02.000Z', lastError: null,
      });

      await db.syncQueue.add({
        entityType: 'productChangeEvent',
        operation: 'insert',
        entityId: 'change-1',
        clientId: 'change-1',
        payload: {
          id: 'change-1', productId: 'prod-1', field: 'name',
          oldValue: 'a', newValue: 'b',
          timestamp: '2026-09-12T10:00:03.000Z', accepted: true,
        },
        attempts: 0, status: 'pending', createdAt: '2026-09-12T10:00:03.000Z', lastError: null,
      });

      const capturedRequests = [];
      mockFetchQueue(
        [
          { status: 200, body: { ok: true } },
          { status: 200, body: { ok: true } },
          { status: 200, body: { ok: true } },
          { status: 200, body: { ok: true } },
        ],
        { onRequest: (url, init) => capturedRequests.push({ url, body: JSON.parse(init.body) }) }
      );

      const result = await chain.syncDrainer.drain();

      expect(result.processed).toBe(4);

      const productRequest = capturedRequests.find((r) => r.url.includes('/api/products/'));
      expect(Object.hasOwn(productRequest.body, 'quantity')).toBe(false);

      const stockEventRequest = capturedRequests.find((r) => r.url.includes('/api/stock-events/'));
      expect(Object.hasOwn(stockEventRequest.body, 'appliedQuantity')).toBe(false);
      expect(stockEventRequest.body.expectedCurrentQuantity).toBe(10);

      const changeEventRequest = capturedRequests.find((r) => r.url.includes('/api/product-change-events/'));
      expect(Object.hasOwn(changeEventRequest.body, 'accepted')).toBe(false);

      expect(await db.syncQueue.toArray()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 401-recovery is transparent to the sync layer
  // ---------------------------------------------------------------------------

  describe('401 recovery, fully transparent to the drainer', () => {
    it('a 401 mid-drain triggers a real refresh and retry, and the drain still succeeds', async () => {
      await seedQueueEntry();

      mockFetchQueue([
        { status: 200, body: { accessToken: 'stale-access', refreshToken: 'refresh-2' } }, // restoreSession's refresh
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } }, // first sync attempt
        { status: 200, body: { accessToken: 'fresh-access', refreshToken: 'refresh-3' } }, // apiClient's 401-triggered refresh
        { status: 200, body: { id: 'cat-1' } }, // retried sync attempt, now succeeds
      ]);

      await chain.authManager.restoreSession(); // establishes an initial access token
      const result = await chain.syncDrainer.drain();

      // The drainer/classifier never see a 401 at all -- apiClient +
      // authManager handled it entirely beneath them, transparently.
      expect(result).toEqual({ processed: 1, failed: 0, stopped: false, reason: null });
      expect(await db.syncQueue.toArray()).toEqual([]);
    });

    it('the rotated refresh token from the 401-triggered refresh is actually persisted to the real session table', async () => {
      await seedQueueEntry();

      mockFetchQueue([
        { status: 200, body: { accessToken: 'stale-access', refreshToken: 'refresh-2' } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } },
        { status: 200, body: { accessToken: 'fresh-access', refreshToken: 'refresh-3' } },
        { status: 200, body: { id: 'cat-1' } },
      ]);

      await chain.authManager.restoreSession();
      await chain.syncDrainer.drain();

      const persisted = await chain.sessionStore.getRefreshToken();
      expect(persisted).toBe('refresh-3');
    });
  });

  // ---------------------------------------------------------------------------
  // Refresh token itself expired — genuine auth failure, drain stops
  // ---------------------------------------------------------------------------

  describe('refresh token rejected — genuine auth failure', () => {
    it('propagates as AUTH_ERROR through the real chain, stopping the drain with the entry left processing', async () => {
      const localId = await seedQueueEntry();

      mockFetchQueue([
        { status: 200, body: { accessToken: 'stale-access', refreshToken: 'refresh-2' } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } } }, // first sync attempt
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Refresh token expired.' } } }, // refresh itself fails
      ]);

      await chain.authManager.restoreSession();
      const result = await chain.syncDrainer.drain();

      expect(result).toEqual({ processed: 0, failed: 0, stopped: true, reason: 'authError' });

      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');
    });

    it('the local session is genuinely cleared (real authManager state, not simulated)', async () => {
      await seedQueueEntry();

      mockFetchQueue([
        { status: 200, body: { accessToken: 'stale-access', refreshToken: 'refresh-2' } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } },
        { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Refresh token expired.' } } },
      ]);

      await chain.authManager.restoreSession();
      await chain.syncDrainer.drain();

      expect(chain.authManager.getStatus()).toBe('unauthenticated');
      expect(chain.authManager.getAccessToken()).toBeNull();
      expect(await chain.sessionStore.getRefreshToken()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Permanent rejection — real formatted lastError, drain continues
  // ---------------------------------------------------------------------------

  describe('permanent rejection', () => {
    it('a 400 through the real chain marks the entry failed with the real formatted lastError, and continues', async () => {
      await seedQueueEntry({ entityId: 'cat-1' });
      await db.syncQueue.add({
        entityType: 'category', operation: 'upsert', entityId: 'cat-2', clientId: 'client-2',
        payload: { id: 'cat-2', name: 'Beverages', archived: false, isDefault: false },
        attempts: 0, status: 'pending', createdAt: '2026-09-12T10:00:01.000Z', lastError: null,
      });

      mockFetchQueue([
        { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Name is required.' } } },
        { status: 200, body: { id: 'cat-2' } },
      ]);

      const result = await chain.syncDrainer.drain();

      expect(result).toEqual({ processed: 1, failed: 1, stopped: false, reason: null });

      const remaining = await db.syncQueue.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('failed');
      expect(remaining[0].lastError).toBe('VALIDATION_ERROR: Name is required. (400)');
    });
  });

  // ---------------------------------------------------------------------------
  // Crash recovery across drains, through the real chain
  // ---------------------------------------------------------------------------

  describe('crash recovery through the full chain', () => {
    it('a stale processing row (simulated crash) is recovered and successfully synced on the next drain', async () => {
      const localId = await seedQueueEntry({ status: 'processing' });

      mockFetchQueue([{ status: 200, body: { id: 'cat-1' } }]);

      const result = await chain.syncDrainer.drain();

      expect(result.processed).toBe(1);
      expect(await db.syncQueue.get(localId)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Network failure through the real chain
  // ---------------------------------------------------------------------------

  describe('network failure', () => {
    it('a real transport failure stops the drain, leaving the entry pending-eligible on the next drain', async () => {
      const localId = await seedQueueEntry();
      global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      const result = await chain.syncDrainer.drain();

      expect(result).toEqual({ processed: 0, failed: 0, stopped: true, reason: 'apiNetworkError' });

      const stored = await db.syncQueue.get(localId);
      expect(stored.status).toBe('processing');

      // A later drain's own recovery pass reclaims it.
      mockFetchQueue([{ status: 200, body: { id: 'cat-1' } }]);
      const second = await chain.syncDrainer.drain();
      expect(second.processed).toBe(1);
    });
  });
});
