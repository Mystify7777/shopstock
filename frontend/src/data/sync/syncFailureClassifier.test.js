import { describe, it, expect } from 'vitest';
import { classifySyncOutcome, SYNC_ACTION } from './syncFailureClassifier.js';
import { SYNC_OUTCOME } from './syncEntryExecutor.js';
import { ApiRequestError, ApiNetworkError } from '../../auth/apiClient.js';
import { AuthApiError, AuthNetworkError } from '../../auth/authClient.js';

describe('classifySyncOutcome', () => {
  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------

  describe('success', () => {
    it('maps SUCCESS to action: delete', () => {
      const decision = classifySyncOutcome({ kind: SYNC_OUTCOME.SUCCESS, response: { ok: true } });
      expect(decision).toEqual({ action: SYNC_ACTION.DELETE });
    });
  });

  // ---------------------------------------------------------------------------
  // Unconditionally transient outcomes (stop drain, no HTTP status involved)
  // ---------------------------------------------------------------------------

  describe('apiNetworkError', () => {
    it('maps to action: stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_NETWORK_ERROR, error: new ApiNetworkError(new Error('offline')) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });
  });

  describe('authNetworkError', () => {
    it('maps to action: stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.AUTH_NETWORK_ERROR, error: new AuthNetworkError(new Error('offline')) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });
  });

  describe('authError', () => {
    it('maps to action: stopDrain (session is dead, user must re-authenticate)', () => {
      const outcome = { kind: SYNC_OUTCOME.AUTH_ERROR, error: new AuthApiError('UNAUTHORIZED', 'Refresh token expired.', 401) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('does not mark the entry failed -- the entry itself is not at fault', () => {
      const outcome = { kind: SYNC_OUTCOME.AUTH_ERROR, error: new AuthApiError('UNAUTHORIZED', 'Refresh token expired.', 401) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).not.toBe(SYNC_ACTION.MARK_FAILED);
    });
  });

  // ---------------------------------------------------------------------------
  // ApiRequestError — status-dependent branch (the one with real policy)
  // ---------------------------------------------------------------------------

  describe('apiError — transient HTTP statuses', () => {
    it('408 (Request Timeout) maps to stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('TIMEOUT', 'Request timed out.', 408) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('429 (Too Many Requests) maps to stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('RATE_LIMITED', 'Too many requests.', 429) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('500 (Internal Server Error) maps to stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('INTERNAL_ERROR', 'Something broke.', 500) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('503 (Service Unavailable) maps to stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('INTERNAL_ERROR', 'Service unavailable.', 503) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('599 (upper bound of 5xx) maps to stopDrain', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('INTERNAL_ERROR', 'x', 599) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.STOP_DRAIN);
    });

    it('does not mark a transient failure as failed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('INTERNAL_ERROR', 'x', 500) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.lastError).toBeUndefined();
    });
  });

  describe('apiError — permanent HTTP statuses (boundary values)', () => {
    it('400 (Bad Request / VALIDATION_ERROR) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'Bad request.', 400) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('401 (should not normally reach here -- apiClient already handles 401 -- but is still classified as permanent if it does)', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('UNAUTHORIZED', 'x', 401) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('403 (FORBIDDEN) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('FORBIDDEN', 'x', 403) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('404 (NOT_FOUND) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('NOT_FOUND', 'x', 404) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('407 (just below the transient 408 boundary) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('UNKNOWN_ERROR', 'x', 407) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('409 (CONFLICT / QUANTITY_CONSISTENCY_CONFLICT) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('QUANTITY_CONSISTENCY_CONFLICT', 'Stale quantity.', 409) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('430 (just above the transient 429 boundary) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('UNKNOWN_ERROR', 'x', 430) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });

    it('499 (just below the 5xx transient range) maps to markFailed', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('UNKNOWN_ERROR', 'x', 499) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.action).toBe(SYNC_ACTION.MARK_FAILED);
    });
  });

  // ---------------------------------------------------------------------------
  // lastError formatting
  // ---------------------------------------------------------------------------

  describe('lastError formatting', () => {
    it('includes the backend code, message, and status', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'Quantity must be positive.', 400) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.lastError).toBe('VALIDATION_ERROR: Quantity must be positive. (400)');
    });

    it('produces a plain string, not an object', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('NOT_FOUND', 'x', 404) };
      const decision = classifySyncOutcome(outcome);
      expect(typeof decision.lastError).toBe('string');
    });

    it('does not include a stack trace', () => {
      const error = new ApiRequestError('VALIDATION_ERROR', 'x', 400);
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error };
      const decision = classifySyncOutcome(outcome);
      expect(decision.lastError).not.toContain(error.stack);
      expect(decision.lastError).not.toMatch(/at\s+\S+\s+\(/); // typical stack-frame shape
    });

    it('does not include any token-like content', () => {
      const error = new ApiRequestError('UNAUTHORIZED', 'Invalid or expired token.', 401);
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error };
      const decision = classifySyncOutcome(outcome);
      // The message itself may legitimately mention "token" in prose,
      // but the formatted string must never contain header/bearer
      // syntax, confirming no raw request data leaked in.
      expect(decision.lastError).not.toMatch(/Bearer\s+\S+/);
      expect(decision.lastError).not.toMatch(/Authorization/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Unrecognized outcome kind
  // ---------------------------------------------------------------------------

  describe('unrecognized outcome kind', () => {
    it('throws rather than silently choosing an action', () => {
      expect(() => classifySyncOutcome({ kind: 'somethingMadeUp' })).toThrow(TypeError);
    });
  });

  // ---------------------------------------------------------------------------
  // Purity / no side effects
  // ---------------------------------------------------------------------------

  describe('purity', () => {
    it('does not mutate the outcome object passed in', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'x', 400) };
      const snapshot = { kind: outcome.kind, error: outcome.error };
      classifySyncOutcome(outcome);
      expect(outcome.kind).toBe(snapshot.kind);
      expect(outcome.error).toBe(snapshot.error);
    });

    it('the same outcome classified twice produces the same decision', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'x', 400) };
      const first = classifySyncOutcome(outcome);
      const second = classifySyncOutcome(outcome);
      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope boundary
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not increment attempts or return an attempts field', () => {
      const outcome = { kind: SYNC_OUTCOME.API_ERROR, error: new ApiRequestError('VALIDATION_ERROR', 'x', 400) };
      const decision = classifySyncOutcome(outcome);
      expect(decision.attempts).toBeUndefined();
    });
  });
});
