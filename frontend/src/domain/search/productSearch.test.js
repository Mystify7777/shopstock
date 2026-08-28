import { describe, it, expect } from 'vitest';
import { searchProducts, isEmptyQuery } from './productSearch.js';

// Pure domain tests -- no Dexie, no fake-indexeddb, no service, no React.
// Fixtures are plain SearchableProduct-shaped objects built by hand,
// mirroring what productService will actually denormalize in practice.

function makeEntry(overrides = {}) {
  return {
    product: { id: overrides.id || 'p1', name: overrides.name || 'Product' },
    name: overrides.name || 'Product',
    notes: overrides.notes || '',
    category: overrides.category || '',
    tags: overrides.tags || [],
    locations: overrides.locations || [],
    ...overrides
  };
}

describe('searchProducts', () => {
  // =========================================================================
  // Exact match -- deterministic, not Fuse-score-based
  // =========================================================================

  describe('exact match detection', () => {
    it('detects an exact name match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'Parle-G');
      expect(result.hasExactMatch).toBe(true);
    });

    it('detects an exact category match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', category: 'Snacks' })];
      const result = searchProducts(entries, 'Snacks');
      expect(result.hasExactMatch).toBe(true);
    });

    it('detects an exact tag match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', tags: ['popular', 'seasonal'] })];
      const result = searchProducts(entries, 'popular');
      expect(result.hasExactMatch).toBe(true);
    });

    it('detects an exact location match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', locations: ['Shelf A2'] })];
      const result = searchProducts(entries, 'Shelf A2');
      expect(result.hasExactMatch).toBe(true);
    });

    it('is case-insensitive for exact match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'parle-g');
      expect(result.hasExactMatch).toBe(true);
    });

    it('does NOT treat a fuzzy/typo match as exact', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'parleg'); // PRD's own example
      expect(result.hasExactMatch).toBe(false);
    });

    it('does NOT treat a substring match as exact', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G Biscuits' })];
      const result = searchProducts(entries, 'Parle-G');
      expect(result.hasExactMatch).toBe(false);
    });

    it('an exact notes match DOES set hasExactMatch (exactness and relevance are separate concerns)', () => {
      // Per the corrective-pass contract: the PRD defines search as
      // operating across name, category, tags, locations, AND notes.
      // Notes remains the lowest-WEIGHTED field for relevance ranking,
      // but exactness checks every searchable field equally.
      const entries = [makeEntry({ id: 'p1', name: 'X', notes: 'Parle-G' })];
      const result = searchProducts(entries, 'Parle-G');
      expect(result.hasExactMatch).toBe(true);
    });

    it('a substring within notes is NOT an exact match (whole-field equality only)', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', notes: 'crunchy Parle-G biscuit' })];
      const result = searchProducts(entries, 'Parle-G');
      expect(result.hasExactMatch).toBe(false);
    });

    it('is not fooled by an arbitrary Fuse score threshold -- exact match is independent of scoring', () => {
      // Two entries: one is an exact match, one is a very close fuzzy match.
      // hasExactMatch must be driven by the exact entry only.
      const entries = [
        makeEntry({ id: 'p1', name: 'Parle-G' }),
        makeEntry({ id: 'p2', name: 'Parle G' }) // no hyphen -- close but not exact
      ];
      const result = searchProducts(entries, 'Parle-G');
      expect(result.hasExactMatch).toBe(true);
    });
  });

  // =========================================================================
  // Fuzzy matching
  // =========================================================================

  describe('fuzzy matching', () => {
    it('finds a partial name match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'Parle');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it("finds the PRD's own typo example (parleg -> Parle-G)", () => {
      const entries = [
        makeEntry({ id: 'p1', name: 'Parle-G' }),
        makeEntry({ id: 'p2', name: 'Parle Marie' })
      ];
      const result = searchProducts(entries, 'parleg');
      const ids = result.matches.map((p) => p.id);
      expect(ids).toContain('p1');
    });

    it('is case-insensitive for fuzzy matching', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'PARLE');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it('matches on notes', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', notes: 'crunchy biscuit' })];
      const result = searchProducts(entries, 'crunchy');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it('matches on category', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', category: 'Snacks' })];
      const result = searchProducts(entries, 'Snacks');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it('matches on tags', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', tags: ['fast-moving'] })];
      const result = searchProducts(entries, 'fast-moving');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it('matches on locations', () => {
      const entries = [makeEntry({ id: 'p1', name: 'X', locations: ['Back Room'] })];
      const result = searchProducts(entries, 'Back Room');
      expect(result.matches.map((p) => p.id)).toContain('p1');
    });

    it('returns no matches for a query with nothing similar', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'zzzzznomatchzzzzz');
      expect(result.matches).toHaveLength(0);
    });
  });

  // =========================================================================
  // Weighted relevance
  // =========================================================================

  describe('weighted relevance', () => {
    it('ranks a name match above a notes-only match for the same query term', () => {
      const entries = [
        makeEntry({ id: 'notes-match', name: 'Unrelated Product', notes: 'mentions biscuit here' }),
        makeEntry({ id: 'name-match', name: 'Biscuit Deluxe', notes: '' })
      ];
      const result = searchProducts(entries, 'biscuit');
      const ids = result.matches.map((p) => p.id);
      expect(ids.indexOf('name-match')).toBeLessThan(ids.indexOf('notes-match'));
    });
  });

  // =========================================================================
  // Empty / whitespace query
  // =========================================================================

  describe('empty query handling', () => {
    it('returns empty matches for an empty string', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, '');
      expect(result).toEqual({ matches: [], related: [], hasExactMatch: false });
    });

    it('returns empty matches for a whitespace-only string', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, '   ');
      expect(result).toEqual({ matches: [], related: [], hasExactMatch: false });
    });

    it('isEmptyQuery() correctly identifies whitespace-only as empty', () => {
      expect(isEmptyQuery('   ')).toBe(true);
      expect(isEmptyQuery('')).toBe(true);
      expect(isEmptyQuery('a')).toBe(false);
    });
  });

  // =========================================================================
  // Whitespace normalization
  // =========================================================================

  describe('whitespace normalization', () => {
    it('trims leading/trailing whitespace before matching', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, '  Parle-G  ');
      expect(result.hasExactMatch).toBe(true);
    });

    it('collapses internal whitespace runs for exact match', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle G' })];
      const result = searchProducts(entries, 'Parle    G');
      expect(result.hasExactMatch).toBe(true);
    });
  });

  // =========================================================================
  // No-match behavior
  // =========================================================================

  describe('no match', () => {
    it('returns a clean empty matches array, not an error, when nothing matches', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'xyznonexistentqueryxyz');
      expect(result.matches).toEqual([]);
      expect(result.hasExactMatch).toBe(false);
    });

    it('handles an empty product list', () => {
      const result = searchProducts([], 'anything');
      expect(result.matches).toEqual([]);
      expect(result.hasExactMatch).toBe(false);
    });
  });

  // =========================================================================
  // No mutation of source Product objects
  // =========================================================================

  describe('no mutation', () => {
    it('does not mutate the original product object', () => {
      const product = { id: 'p1', name: 'Parle-G', quantity: 10 };
      const entry = makeEntry({ id: 'p1', name: 'Parle-G', product });
      const before = JSON.stringify(product);
      searchProducts([entry], 'Parle-G');
      expect(JSON.stringify(product)).toBe(before);
    });

    it('returned matches reference the same product object, not a copy', () => {
      const product = { id: 'p1', name: 'Parle-G' };
      const entry = makeEntry({ id: 'p1', name: 'Parle-G', product });
      const result = searchProducts([entry], 'Parle-G');
      expect(result.matches[0]).toBe(product);
    });

    it('does not mutate the input searchableProducts array', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const before = JSON.stringify(entries);
      searchProducts(entries, 'Parle-G');
      expect(JSON.stringify(entries)).toBe(before);
    });
  });
});
