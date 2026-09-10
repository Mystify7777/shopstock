import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../data/db/schema.js';
import { createSessionStore } from './sessionStore.js';

describe('sessionStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createDatabase();
    store = createSessionStore(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // ---------------------------------------------------------------------------
  // getRefreshToken — no persisted session
  // ---------------------------------------------------------------------------

  describe('getRefreshToken — no persisted session', () => {
    it('returns null when no session record exists', async () => {
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setRefreshToken / getRefreshToken round-trip
  // ---------------------------------------------------------------------------

  describe('setRefreshToken / getRefreshToken', () => {
    it('persists and returns the exact refresh token', async () => {
      await store.setRefreshToken('refresh-token-abc123');
      const token = await store.getRefreshToken();
      expect(token).toBe('refresh-token-abc123');
    });

    it('a second setRefreshToken call fully replaces the previous value', async () => {
      await store.setRefreshToken('first-token');
      await store.setRefreshToken('second-token');
      const token = await store.getRefreshToken();
      expect(token).toBe('second-token');
    });

    it('persists only the refreshToken field — no extra state leaks in', async () => {
      await store.setRefreshToken('refresh-token-abc123');
      const record = await db.session.get('current');
      expect(record.value).toEqual({ refreshToken: 'refresh-token-abc123' });
    });

    it('throws for a non-string refreshToken', async () => {
      await expect(store.setRefreshToken(12345)).rejects.toThrow(TypeError);
      await expect(store.setRefreshToken(null)).rejects.toThrow(TypeError);
      await expect(store.setRefreshToken(undefined)).rejects.toThrow(TypeError);
    });

    it('throws for an empty-string refreshToken', async () => {
      await expect(store.setRefreshToken('')).rejects.toThrow(TypeError);
    });

    it('rejecting an invalid refreshToken does not write a partial record', async () => {
      await expect(store.setRefreshToken('')).rejects.toThrow(TypeError);
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // clearRefreshToken
  // ---------------------------------------------------------------------------

  describe('clearRefreshToken', () => {
    it('removes a previously persisted refresh token', async () => {
      await store.setRefreshToken('refresh-token-abc123');
      await store.clearRefreshToken();
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });

    it('deletes the underlying row entirely, not just the field', async () => {
      await store.setRefreshToken('refresh-token-abc123');
      await store.clearRefreshToken();
      const record = await db.session.get('current');
      expect(record).toBeUndefined();
    });

    it('is safe to call when no session record exists', async () => {
      await expect(store.clearRefreshToken()).resolves.not.toThrow();
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });

    it('is safe to call twice in a row', async () => {
      await store.setRefreshToken('refresh-token-abc123');
      await store.clearRefreshToken();
      await expect(store.clearRefreshToken()).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Malformed / unexpected existing record shapes
  // ---------------------------------------------------------------------------

  describe('malformed existing record', () => {
    it('treats a record whose value has no refreshToken field as no persisted session', async () => {
      await db.session.put({ key: 'current', value: {} });
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });

    it('treats a record whose value is not an object as no persisted session', async () => {
      await db.session.put({ key: 'current', value: 'not-an-object' });
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });

    it('treats a record whose value is null as no persisted session', async () => {
      await db.session.put({ key: 'current', value: null });
      const token = await store.getRefreshToken();
      expect(token).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // No HTTP / no auth-state coupling — sessionStore is pure persistence
  // ---------------------------------------------------------------------------

  describe('scope boundary', () => {
    it('does not expose any access-token-related method', () => {
      expect(store.getAccessToken).toBeUndefined();
      expect(store.setAccessToken).toBeUndefined();
    });

    it('does not expose any HTTP/network method', () => {
      expect(store.login).toBeUndefined();
      expect(store.refresh).toBeUndefined();
      expect(store.logout).toBeUndefined();
    });
  });
});
