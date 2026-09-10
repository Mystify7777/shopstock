import { describe, it, expect, vi } from 'vitest';
import { createSyncEntryExecutor, SYNC_OUTCOME } from './syncEntryExecutor.js';
import { ApiRequestError, ApiNetworkError } from '../../auth/apiClient.js';
import { AuthApiError, AuthNetworkError } from '../../auth/authClient.js';

function makeMockApiClient() {
  return { request: vi.fn() };
}

function makeCategoryEntry(overrides = {}) {
  return {
    localId: 1,
    entityType: 'category',
    operation: 'upsert',
    entityId: 'cat-1',
    clientId: 'client-1',
    payload: { id: 'cat-1', name: 'Snacks', archived: false, isDefault: false },
    attempts: 0,
    status: 'processing',
    createdAt: '2026-09-10T10:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

describe('syncEntryExecutor', () => {
  describe('createSyncEntryExecutor', () => {
    it('throws if apiClient is missing', () => {
      expect(() => createSyncEntryExecutor({})).toThrow(TypeError);
    });
  });

  describe('executeSyncEntry — translation', () => {
    it('calls apiClient.request with the exact output of createSyncRequest(entry)', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockResolvedValue({ ok: true });
      const executor = createSyncEntryExecutor({ apiClient });

      await executor.executeSyncEntry(makeCategoryEntry());

      expect(apiClient.request).toHaveBeenCalledWith({
        method: 'PUT',
        path: '/api/categories/cat-1',
        body: { id: 'cat-1', name: 'Snacks', archived: false, isDefault: false },
      });
    });

    it('translates a stockEvent entry correctly, stripping appliedQuantity for the wire', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockResolvedValue({ ok: true });
      const executor = createSyncEntryExecutor({ apiClient });

      const entry = makeCategoryEntry({
        entityType: 'stockEvent',
        entityId: 'evt-1',
        payload: {
          id: 'evt-1',
          productId: 'prod-1',
          type: 'ADD',
          quantity: 5,
          recordedAt: '2026-09-10T10:00:00.000Z',
          expectedCurrentQuantity: 10,
          appliedQuantity: 5,
        },
      });

      await executor.executeSyncEntry(entry);

      const [request] = apiClient.request.mock.calls[0];
      expect(request.path).toBe('/api/stock-events/evt-1');
      expect(Object.hasOwn(request.body, 'appliedQuantity')).toBe(false);
      expect(request.body.expectedCurrentQuantity).toBe(10);
    });
  });

  describe('executeSyncEntry — success', () => {
    it('returns kind: success with the response body', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockResolvedValue({ id: 'cat-1', name: 'Snacks' });
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome).toEqual({
        kind: SYNC_OUTCOME.SUCCESS,
        response: { id: 'cat-1', name: 'Snacks' },
      });
    });

    it('never throws on success', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockResolvedValue({ ok: true });
      const executor = createSyncEntryExecutor({ apiClient });

      await expect(executor.executeSyncEntry(makeCategoryEntry())).resolves.not.toThrow();
    });
  });

  describe('executeSyncEntry — failure classification', () => {
    it('classifies ApiRequestError as apiError, never throwing', async () => {
      const apiClient = makeMockApiClient();
      const error = new ApiRequestError('VALIDATION_ERROR', 'Bad request.', 400);
      apiClient.request.mockRejectedValue(error);
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome.kind).toBe(SYNC_OUTCOME.API_ERROR);
      expect(outcome.error).toBe(error);
    });

    it('classifies ApiNetworkError as apiNetworkError', async () => {
      const apiClient = makeMockApiClient();
      const error = new ApiNetworkError(new Error('offline'));
      apiClient.request.mockRejectedValue(error);
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome.kind).toBe(SYNC_OUTCOME.API_NETWORK_ERROR);
      expect(outcome.error).toBe(error);
    });

    it('classifies AuthApiError as authError', async () => {
      const apiClient = makeMockApiClient();
      const error = new AuthApiError('UNAUTHORIZED', 'Refresh token expired.', 401);
      apiClient.request.mockRejectedValue(error);
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome.kind).toBe(SYNC_OUTCOME.AUTH_ERROR);
      expect(outcome.error).toBe(error);
    });

    it('classifies AuthNetworkError as authNetworkError', async () => {
      const apiClient = makeMockApiClient();
      const error = new AuthNetworkError(new Error('offline'));
      apiClient.request.mockRejectedValue(error);
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome.kind).toBe(SYNC_OUTCOME.AUTH_NETWORK_ERROR);
      expect(outcome.error).toBe(error);
    });

    it('preserves the exact backend code/status on an apiError outcome', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockRejectedValue(
        new ApiRequestError('QUANTITY_CONSISTENCY_CONFLICT', 'Stale quantity.', 409)
      );
      const executor = createSyncEntryExecutor({ apiClient });

      const outcome = await executor.executeSyncEntry(makeCategoryEntry());

      expect(outcome.error.code).toBe('QUANTITY_CONSISTENCY_CONFLICT');
      expect(outcome.error.status).toBe(409);
    });

    it('rethrows an error type outside the four documented possibilities, rather than misclassifying it', async () => {
      const apiClient = makeMockApiClient();
      const unexpectedError = new TypeError('something unrelated broke');
      apiClient.request.mockRejectedValue(unexpectedError);
      const executor = createSyncEntryExecutor({ apiClient });

      await expect(executor.executeSyncEntry(makeCategoryEntry())).rejects.toBe(unexpectedError);
    });
  });

  describe('executeSyncEntry — does not mutate the queue or call lifecycle functions', () => {
    it('does not mutate the entry object passed in', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockResolvedValue({ ok: true });
      const executor = createSyncEntryExecutor({ apiClient });

      const entry = makeCategoryEntry();
      const snapshot = JSON.parse(JSON.stringify(entry));
      await executor.executeSyncEntry(entry);

      expect(entry).toEqual(snapshot);
    });

    it('does not expose any syncQueue/lifecycle-mutating method', () => {
      const apiClient = makeMockApiClient();
      const executor = createSyncEntryExecutor({ apiClient });
      expect(executor.markSucceeded).toBeUndefined();
      expect(executor.markFailed).toBeUndefined();
      expect(executor.claimNextPending).toBeUndefined();
    });
  });

  describe('scope boundary', () => {
    it('does not expose a drain/loop method', () => {
      const apiClient = makeMockApiClient();
      const executor = createSyncEntryExecutor({ apiClient });
      expect(executor.drain).toBeUndefined();
      expect(executor.processQueue).toBeUndefined();
    });

    it('calls apiClient.request at most once per executeSyncEntry call -- no internal retry', async () => {
      const apiClient = makeMockApiClient();
      apiClient.request.mockRejectedValue(new ApiNetworkError(new Error('offline')));
      const executor = createSyncEntryExecutor({ apiClient });

      await executor.executeSyncEntry(makeCategoryEntry());

      expect(apiClient.request).toHaveBeenCalledTimes(1);
    });
  });
});
