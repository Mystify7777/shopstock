// Product search -- pure domain logic.
//
// This module owns:
//   - query normalization
//   - deterministic exact-match detection (NOT Fuse score-based -- see
//     below)
//   - Fuse.js weighted fuzzy configuration and invocation
//   - relevance ordering (Fuse's own ascending score)
//
// This module does NOT:
//   - import React, Dexie, or any browser API
//   - know where its input came from (no repositories, no services, no
//     AppContext)
//   - perform network requests
//   - mutate any Product object it receives -- results reference the same
//     product objects, never copies with fields added/removed
//
// EXACT MATCH SEMANTICS (per the approved Phase 4A contract): exactness is
// NEVER determined by inspecting a Fuse.js score. An exact match means the
// normalized query string exactly equals a normalized searchable field
// value. Fuse.js determines fuzzy relevance ordering; this module's own
// normalization/equality logic determines exactness. This is a deliberate,
// explicit design decision -- not an incidental implementation detail.

import Fuse from 'fuse.js';

// ---------------------------------------------------------------------------
// Weighted fields
//
// Only "name > notes" is directly stated in the PRD/Build Brief ("Use
// weighted fields so product-name matches rank above incidental note
// matches" -- Build Brief SS22). The specific numeric split for
// category/tags/locations relative to each other is an implementation
// choice (labeled as such in the approved Phase 4 contract), not a PRD
// citation. These weights are exposed as a named constant, not inlined,
// so the rationale stays visible and the values are easy to revisit.
// ---------------------------------------------------------------------------

const SEARCH_FIELD_WEIGHTS = Object.freeze({
  name: 3,
  category: 2,
  tags: 2,
  locations: 2,
  notes: 1
});

const FUSE_KEYS = Object.freeze([
  { name: 'name', weight: SEARCH_FIELD_WEIGHTS.name },
  { name: 'category', weight: SEARCH_FIELD_WEIGHTS.category },
  { name: 'tags', weight: SEARCH_FIELD_WEIGHTS.tags },
  { name: 'locations', weight: SEARCH_FIELD_WEIGHTS.locations },
  { name: 'notes', weight: SEARCH_FIELD_WEIGHTS.notes }
]);

// Fuse's own default threshold (0.6) is used deliberately -- no evidence
// anywhere in the PRD/Build Brief calls for a custom fuzziness tolerance,
// and the PRD's own worked example ("parleg" -> "Parle-G") is a realistic
// default-threshold match. Not overridden without concrete evidence.
//
// ignoreLocation: true disables Fuse's default position-sensitive scoring
// (by default, Fuse expects matches to appear near the start of a field
// and penalizes matches that occur further in). Product names/notes have
// no reason to favor a match at the start of the string over one in the
// middle -- "parleg" should score the same whether the matched substring
// begins the field or occurs partway through it.
//
// includeScore is intentionally NOT set -- score is never read anywhere
// in this module. Exactness is determined by hasExactFieldMatch() below
// (deterministic string equality), never by inspecting Fuse's score, so
// there is nothing here that needs it.
const FUSE_OPTIONS = Object.freeze({
  keys: FUSE_KEYS,
  ignoreLocation: true
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a string for comparison: trim surrounding whitespace, collapse
 * internal whitespace runs to a single space, lowercase. Used identically
 * for both the query and every searchable field value, so exact-match
 * comparison is meaningful regardless of incidental whitespace/case
 * differences.
 *
 * @param {string|null|undefined} value
 * @returns {string} Empty string for null/undefined/non-string input.
 */
function normalize(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is this normalized query empty (nothing to search for)? Covers both a
 * genuinely empty string and a whitespace-only query, per the approved
 * Phase 4A contract ("do not call the search service for an empty query").
 *
 * @param {string} query Raw, not-yet-normalized query.
 * @returns {boolean}
 */
export function isEmptyQuery(query) {
  return normalize(query).length === 0;
}

// ---------------------------------------------------------------------------
// Exact match detection (deterministic, not Fuse-score-based)
// ---------------------------------------------------------------------------

/**
 * Does this searchable entry contain a field whose normalized value
 * exactly equals the normalized query? Checks EVERY searchable field --
 * name, category, each tag, each location, AND notes.
 *
 * Exactness and relevance are deliberately separate concepts: notes
 * remains the lowest-weighted field for Fuse's relevance ranking (see
 * SEARCH_FIELD_WEIGHTS below), but a field's weight has no bearing on
 * whether an exact match against it counts as exact. The PRD defines
 * search as operating across name, category, tags, locations, AND notes
 * (PRD SS23) -- there is no textual basis for carving notes out of
 * exactness specifically. An exact string equal to the entire notes
 * field is still an exact match; it is simply ranked lower than an
 * equally-exact name match, which is what the weighting is for.
 *
 * @param {SearchableProduct} entry
 * @param {string} normalizedQuery Already normalized.
 * @returns {boolean}
 */
function hasExactFieldMatch(entry, normalizedQuery) {
  if (normalize(entry.name) === normalizedQuery) return true;
  if (normalize(entry.category) === normalizedQuery) return true;
  if (entry.tags.some((tag) => normalize(tag) === normalizedQuery)) return true;
  if (entry.locations.some((loc) => normalize(loc) === normalizedQuery)) return true;
  if (normalize(entry.notes) === normalizedQuery) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public search function
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SearchableProduct
 * @property {object} product   The original Product object (never mutated,
 *   never copied-with-fields-added -- this shape wraps it, doesn't alter
 *   it).
 * @property {string} name      Denormalized from product.name.
 * @property {string} notes     Denormalized from product.notes.
 * @property {string} category  Resolved category name (or '' if none/
 *   unresolvable).
 * @property {string[]} tags    Resolved tag names.
 * @property {string[]} locations Resolved location names.
 */

/**
 * @typedef {object} ProductSearchResult
 * @property {object[]} matches Product objects (unwrapped from their
 *   SearchableProduct entry), ordered by Fuse relevance (best first).
 *   Fuse's own score is NOT included -- callers receive products, not
 *   Fuse internals, per the approved contract.
 * @property {object[]} related Always [] in Phase 4A -- populated in
 *   Phase 4B.
 * @property {boolean} hasExactMatch True if any entry has a field whose
 *   normalized value exactly equals the normalized query.
 */

/**
 * Pure fuzzy + exact product search.
 *
 * @param {SearchableProduct[]} searchableProducts Already-denormalized by
 *   the caller (the service) -- this function performs no ID resolution.
 * @param {string} query Raw, not-yet-normalized query string.
 * @returns {ProductSearchResult}
 */
export function searchProducts(searchableProducts, query) {
  if (isEmptyQuery(query)) {
    return { matches: [], related: [], hasExactMatch: false };
  }

  const normalizedQuery = normalize(query);

  const hasExactMatch = searchableProducts.some((entry) =>
    hasExactFieldMatch(entry, normalizedQuery)
  );

  const fuse = new Fuse(searchableProducts, FUSE_OPTIONS);
  const fuseResults = fuse.search(query);

  const matches = fuseResults.map((result) => result.item.product);

  return { matches, related: [], hasExactMatch };
}
