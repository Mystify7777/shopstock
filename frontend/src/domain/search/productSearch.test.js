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

  // =========================================================================
  // Related results (Phase 4B) -- aggregate metadata pool over ALL matches,
  // deterministic four-tier ranking, disjoint from matches.
  // =========================================================================

  describe('related results', () => {
    // Fixture spanning multiple products/categories/tags/locations so
    // aggregate-pool behavior is actually exercised, per the approved
    // Phase 4B contract's fixture requirement -- not a trivial single-match
    // fixture that would merely imply the aggregate behavior.
    function multiMatchFixture() {
      return [
        // The three closest fuzzy matches for query "biscuit":
        makeEntry({
          id: 'm1',
          name: 'Parle-G Biscuit',
          category: 'Snacks',
          tags: ['popular'],
          locations: ['Shelf A1']
        }),
        makeEntry({
          id: 'm2',
          name: 'Marie Biscuit',
          category: 'Snacks',
          tags: ['seasonal'],
          locations: ['Shelf A2']
        }),
        makeEntry({
          id: 'm3',
          name: 'Good Day Biscuit',
          category: 'Snacks',
          tags: ['fast-moving'],
          locations: ['Back Room']
        }),
        // Candidates:
        makeEntry({
          id: 'cat-only',
          name: 'Hide & Seek',
          category: 'Snacks', // shares category only
          tags: ['unrelated-tag'],
          locations: ['Counter']
        }),
        makeEntry({
          id: 'cat-plus-one-tag',
          name: 'Bourbon',
          category: 'Snacks', // shares category
          tags: ['popular'], // + 1 shared tag
          locations: ['Counter']
        }),
        makeEntry({
          id: 'cat-plus-two-tags',
          name: 'Krackjack',
          category: 'Snacks', // shares category
          tags: ['popular', 'seasonal'], // + 2 shared tags
          locations: ['Counter']
        }),
        makeEntry({
          id: 'no-category-tag-only',
          name: 'Dettol Soap',
          category: 'Personal Care', // does NOT share category
          tags: ['popular'], // shares 1 tag
          locations: ['Shelf A1'] // shares 1 location
        }),
        makeEntry({
          id: 'unrelated',
          name: 'Notebook',
          category: 'Stationery',
          tags: ['stationery-tag'],
          locations: ['Back Room'] // shares 1 location only -- still related
        }),
        makeEntry({
          id: 'no-overlap',
          name: 'Random Item',
          category: 'Cleaning',
          tags: ['nothing-shared'],
          locations: ['Nowhere']
        })
      ];
    }

    function runSearch(entries) {
      // "biscuit" fuzzy-matches m1/m2/m3 by name; none of them are an exact
      // match for the raw query, and none of the candidate names contain
      // "biscuit", so Fuse's own result set is exactly the intended
      // matches/candidates split for this fixture.
      return searchProducts(entries, 'biscuit');
    }

    it('exact match produces no related results', () => {
      const entries = [
        makeEntry({ id: 'p1', name: 'Biscuit', category: 'Snacks' }),
        makeEntry({ id: 'p2', name: 'Cookie', category: 'Snacks' })
      ];
      const result = searchProducts(entries, 'Biscuit');
      expect(result.hasExactMatch).toBe(true);
      expect(result.related).toEqual([]);
    });

    it('fuzzy-only results with metadata overlap produce related results', () => {
      const result = runSearch(multiMatchFixture());
      expect(result.hasExactMatch).toBe(false);
      expect(result.related.length).toBeGreaterThan(0);
    });

    it('derives related candidates from the aggregate pool of ALL matches, not just one', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = result.related.map((p) => p.id);
      // 'no-category-tag-only' shares tag 'popular' which comes from match
      // m1 specifically -- only reachable if the pool aggregates across all
      // matches, not just (say) the single best match.
      expect(relatedIds).toContain('no-category-tag-only');
      // 'unrelated' shares only a location ('Back Room') sourced from m3.
      expect(relatedIds).toContain('unrelated');
    });

    it('shared category outranks candidates without shared category, regardless of tag/location counts', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = result.related.map((p) => p.id);

      const catOnlyIndex = relatedIds.indexOf('cat-only'); // category, 0 tags, 0 locations
      const noCategoryIndex = relatedIds.indexOf('no-category-tag-only'); // no category, 1 tag, 1 location

      expect(catOnlyIndex).toBeGreaterThanOrEqual(0);
      expect(noCategoryIndex).toBeGreaterThanOrEqual(0);
      expect(catOnlyIndex).toBeLessThan(noCategoryIndex);
    });

    it('within the same category tier, more shared tags ranks higher', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = result.related.map((p) => p.id);

      const twoTags = relatedIds.indexOf('cat-plus-two-tags');
      const oneTag = relatedIds.indexOf('cat-plus-one-tag');
      const zeroTags = relatedIds.indexOf('cat-only');

      expect(twoTags).toBeLessThan(oneTag);
      expect(oneTag).toBeLessThan(zeroTags);
    });

    it('within the same category+tag tier, more shared locations ranks higher', () => {
      const entries = [
        makeEntry({ id: 'm1', name: 'Parle-G Biscuit', category: 'Snacks', tags: [], locations: ['Shelf A1', 'Counter'] }),
        makeEntry({ id: 'more-locations', name: 'Item A', category: 'Snacks', tags: [], locations: ['Shelf A1', 'Counter'] }),
        makeEntry({ id: 'fewer-locations', name: 'Item B', category: 'Snacks', tags: [], locations: ['Shelf A1'] })
      ];
      const result = searchProducts(entries, 'biscuit');
      const relatedIds = result.related.map((p) => p.id);

      expect(relatedIds.indexOf('more-locations')).toBeLessThan(relatedIds.indexOf('fewer-locations'));
    });

    it('resolves complete ties via stable original searchable-product order', () => {
      const entries = [
        makeEntry({ id: 'm1', name: 'Parle-G Biscuit', category: 'Snacks', tags: [], locations: [] }),
        makeEntry({ id: 'tie-a', name: 'Item A', category: 'Snacks', tags: [], locations: [] }),
        makeEntry({ id: 'tie-b', name: 'Item B', category: 'Snacks', tags: [], locations: [] })
      ];
      const result = searchProducts(entries, 'biscuit');
      const relatedIds = result.related.map((p) => p.id);
      // tie-a appears before tie-b in the original array and both tie on
      // every ranking dimension -- original order must be preserved.
      expect(relatedIds).toEqual(['tie-a', 'tie-b']);
    });

    it('excludes products already present in matches from related results', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = new Set(result.related.map((p) => p.id));
      const matchIds = new Set(result.matches.map((p) => p.id));

      for (const id of matchIds) {
        expect(relatedIds.has(id)).toBe(false);
      }
    });

    it('matches and related are fully disjoint', () => {
      const result = runSearch(multiMatchFixture());
      const matchIds = new Set(result.matches.map((p) => p.id));
      const relatedIds = new Set(result.related.map((p) => p.id));
      const intersection = [...matchIds].filter((id) => relatedIds.has(id));
      expect(intersection).toEqual([]);
    });

    it('deduplicates candidates so each product id appears at most once', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = result.related.map((p) => p.id);
      expect(new Set(relatedIds).size).toBe(relatedIds.length);
    });

    it('products sharing no metadata at all with the matches are excluded from related', () => {
      const result = runSearch(multiMatchFixture());
      const relatedIds = result.related.map((p) => p.id);
      expect(relatedIds).not.toContain('no-overlap');
    });

    it('no fuzzy matches at all produces no related results', () => {
      const entries = [makeEntry({ id: 'p1', name: 'Parle-G' })];
      const result = searchProducts(entries, 'zzzzznomatchzzzzz');
      expect(result.matches).toEqual([]);
      expect(result.related).toEqual([]);
    });

    it('no related candidates found returns a clean empty array, not an error', () => {
      const entries = [
        makeEntry({ id: 'm1', name: 'Solo Biscuit', category: '', tags: [], locations: [] })
      ];
      const result = searchProducts(entries, 'biscuit');
      expect(result.related).toEqual([]);
    });

    it('does not mutate source products or the searchable projection while deriving related results', () => {
      const entries = multiMatchFixture();
      const before = JSON.stringify(entries);
      runSearch(entries);
      expect(JSON.stringify(entries)).toBe(before);
    });
  });

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
