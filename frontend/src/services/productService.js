// Product service.
//
// Orchestration layer between the UI and the domain/repository layers.
// Owns:
//   - calling domain createProduct()/updateProduct() to construct/patch
//     Product objects and get back { product, errors }
//   - diffing old vs. new product to decide which tracked fields changed
//   - constructing ProductChangeEvent objects for tracked-field changes
//     (no domain factory exists for this -- see docs/ARCHITECTURE.md
//     "Tracked vs. non-tracked Product fields" and PROGRESS.md's note that
//     "the factory does not decide when ProductChangeEvents should be
//     created -- that's service-layer orchestration")
//   - calling productRepository to persist
//   - (Phase 4A) loading the active product dataset + resolving
//     classification ID references to display names, building a TRANSIENT
//     in-memory search projection, and delegating to the pure domain
//     search function
//   - (Phase 4C) applying ID-based category/location/tag filters to the
//     active product list BEFORE the searchable projection is built and
//     before the domain search function runs -- see applyFilters()
//
// Does NOT:
//   - import Dexie or create its own database (receives already-built
//     repositories)
//   - duplicate product validation (validateProduct() is called exactly
//     once, inside createProduct()/updateProduct())
//   - calculate stock, cost, or margin
//   - implement repository persistence logic
//   - persist the search projection, mutate Product, or alter IndexedDB
//     records in any way as part of searching -- the projection built for
//     search exists only for the duration of one searchProducts() call
//   - configure or invoke Fuse.js directly (that lives in
//     domain/search/productSearch.js)

import { createProduct, updateProduct } from '../domain/product/productFactory.js';
import { generateId } from '../domain/shared/ids.js';
import { timestampNow } from '../domain/shared/dates.js';
import { searchProducts as domainSearchProducts, isEmptyQuery } from '../domain/search/productSearch.js';

// ---------------------------------------------------------------------------
// Tracked-field mapping
//
// docs/ARCHITECTURE.md's ProductChangeEvent.field is a closed set:
//   'name' | 'category' | 'location' | 'tags' | 'sellingPrice' | 'archived'
//
// Product's own field names differ for the reference-holding fields
// (categoryId, locationIds, tagIds), so this maps Product key -> event
// field string. Verified against docs/ARCHITECTURE.md lines 30-48 and
// 71-76 before writing this file.
// ---------------------------------------------------------------------------

const TRACKED_FIELD_MAP = {
  name: 'name',
  categoryId: 'category',
  locationIds: 'location',
  tagIds: 'tags',
  sellingPrice: 'sellingPrice',
  archived: 'archived'
};

/**
 * Simple deterministic equality check sufficient for the tracked-field set.
 * Scalars (name, categoryId, sellingPrice, archived) compare with ===.
 * Arrays (locationIds, tagIds) compare by JSON-stringified value -- exact
 * order-and-contents equality, which matches how these arrays are actually
 * constructed/replaced wholesale by callers (no partial array mutation
 * exists anywhere in the current domain/service code). No dependency added
 * for this -- JSON.stringify is sufficient for the current data shapes
 * (string[] of ids).
 */
function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Diff two product objects across the closed tracked-field set and return
 * one ProductChangeEvent per field that actually changed. Zero-length
 * result is valid and expected for edits that only touch non-tracked
 * fields (e.g. notes) -- see docs/ARCHITECTURE.md "Tracked vs. non-tracked
 * Product fields".
 *
 * @param {object} existing The product before the patch.
 * @param {object} updated  The product after the patch.
 * @returns {object[]} ProductChangeEvent objects, already fully constructed.
 */
function buildChangeEvents(existing, updated) {
  const events = [];

  for (const [productField, eventField] of Object.entries(TRACKED_FIELD_MAP)) {
    const oldValue = existing[productField];
    const newValue = updated[productField];

    if (!valuesEqual(oldValue, newValue)) {
      events.push({
        id: generateId(),
        productId: updated.id,
        field: eventField,
        oldValue,
        newValue,
        timestamp: timestampNow(),
        accepted: true
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a product service backed by the given repositories.
 *
 * Both repositories are required. searchProducts() resolves categoryId /
 * tagIds / locationIds through classificationRepository -- a missing
 * classificationRepository would surface as a runtime failure only when
 * searchProducts() is actually called, which is worse than failing at
 * construction time. Every call site must supply both.
 *
 * @param {object} productRepository Result of createProductRepository(db).
 * @param {object} classificationRepository Result of
 *   createClassificationRepository(db).
 * @throws {TypeError} If either repository is missing.
 */
export function createProductService(productRepository, classificationRepository) {
  if (!productRepository) {
    throw new TypeError('createProductService() requires a productRepository.');
  }
  if (!classificationRepository) {
    throw new TypeError('createProductService() requires a classificationRepository.');
  }


  /**
   * List products, defaulting to active (non-archived) only.
   *
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<object[]>}
   */
  async function listProducts(options = {}) {
    return productRepository.list(options);
  }

  /**
   * Load a single product by id.
   *
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async function getProduct(id) {
    return productRepository.getById(id);
  }

  /**
   * Construct and persist a new product.
   *
   * Product creation does not generate ProductChangeEvents in V1 -- see
   * docs/ARCHITECTURE.md "Product creation and ProductChangeEvent (V1
   * scope decision)".
   *
   * @param {object} input Fields accepted by domain createProduct().
   * @returns {Promise<{ product: object, errors: string[] }>}
   *   If errors is non-empty, the product was NOT persisted.
   */
  async function createProductUseCase(input) {
    const { product, errors } = createProduct(input);

    if (errors.length > 0) {
      return { product, errors };
    }

    await productRepository.create(product);
    return { product, errors: [] };
  }

  /**
   * Apply a patch to an existing product, construct any resulting
   * ProductChangeEvents for tracked fields, and persist both atomically
   * via productRepository.update().
   *
   * @param {object} existingProduct The current product (already loaded).
   * @param {object} patch Partial fields to change (see domain
   *   updateProduct() for patch semantics and locked fields).
   * @returns {Promise<{ product: object, errors: string[] }>}
   *   If errors is non-empty, nothing was persisted.
   */
  async function updateProductUseCase(existingProduct, patch) {
    const { product, errors } = updateProduct(existingProduct, patch);

    if (errors.length > 0) {
      return { product, errors };
    }

    const changeEvents = buildChangeEvents(existingProduct, product);
    await productRepository.update(product, changeEvents);
    return { product, errors: [] };
  }

  // ---------------------------------------------------------------------------
  // searchProducts (Phase 4A/4B/4C)
  // ---------------------------------------------------------------------------

  /**
   * Apply ID-based classification filters to the active product list,
   * BEFORE the searchable projection is built and before Fuse ever runs
   * (Phase 4C approved contract). Filtering on Product's own
   * categoryId/locationIds/tagIds is deliberately preferred over filtering
   * on resolved display names -- it is immune to renames and to a
   * collision between an active and an archived classification sharing a
   * name.
   *
   * Semantics (locked, Phase 4C):
   *   - categoryId: single-select. A product matches only if its own
   *     categoryId === filters.categoryId.
   *   - locationIds: multi-select, OR within the group. A product matches
   *     if it has AT LEAST ONE of the selected location ids.
   *   - tagIds: multi-select, OR within the group. Same pattern as
   *     locationIds.
   *   - Across groups: AND. All three checks above must independently
   *     pass (an inactive/empty group is always considered passing --
   *     it imposes no constraint).
   *
   * @param {object[]} products
   * @param {{ categoryId?: string|null, locationIds?: string[], tagIds?: string[] }} filters
   * @returns {object[]}
   */
  function applyFilters(products, filters) {
    const { categoryId = null, locationIds = [], tagIds = [] } = filters;

    const hasCategoryFilter = Boolean(categoryId);
    const hasLocationFilter = locationIds.length > 0;
    const hasTagFilter = tagIds.length > 0;

    if (!hasCategoryFilter && !hasLocationFilter && !hasTagFilter) {
      return products;
    }

    return products.filter((product) => {
      if (hasCategoryFilter && product.categoryId !== categoryId) {
        return false;
      }
      if (hasLocationFilter && !(product.locationIds || []).some((id) => locationIds.includes(id))) {
        return false;
      }
      if (hasTagFilter && !(product.tagIds || []).some((id) => tagIds.includes(id))) {
        return false;
      }
      return true;
    });
  }

  /**
   * Build an id -> name lookup map for one classification entity type,
   * across ALL records (including archived) -- a product can still
   * reference an archived category/location/tag, and search must resolve
   * its name rather than crash or silently omit the field. Uses only the
   * existing classificationRepository.list() contract; no batch-resolve
   * method was added, per the approved Phase 4 contract ("do not add a
   * classification batch repository abstraction unless implementation
   * proves the existing API genuinely insufficient" -- it did not).
   *
   * @param {string} entityType 'category' | 'location' | 'tag'
   * @returns {Promise<Map<string, string>>}
   */
  async function buildNameMap(entityType) {
    const records = await classificationRepository.list(entityType, {
      includeArchived: true
    });
    const map = new Map();
    for (const record of records) {
      map.set(record.id, record.name);
    }
    return map;
  }

  /**
   * Resolve a product's classification ID references into display names,
   * building the TRANSIENT search projection the domain search function
   * requires. This projection is never persisted, never written back to
   * IndexedDB, and never mutates the Product object it wraps -- it exists
   * only for the duration of one searchProducts() call.
   *
   * A missing/unresolvable reference (e.g. a categoryId with no matching
   * record) resolves to an empty string / is simply omitted from the
   * tags-or-locations array, rather than throwing -- a dangling reference
   * must not crash search.
   *
   * @param {object} product
   * @param {Map<string,string>} categoryNames
   * @param {Map<string,string>} locationNames
   * @param {Map<string,string>} tagNames
   * @returns {import('../domain/search/productSearch.js').SearchableProduct}
   */
  function toSearchableProduct(product, categoryNames, locationNames, tagNames) {
    return {
      product,
      name: product.name || '',
      notes: product.notes || '',
      category: categoryNames.get(product.categoryId) || '',
      tags: (product.tagIds || [])
        .map((id) => tagNames.get(id))
        .filter(Boolean),
      locations: (product.locationIds || [])
        .map((id) => locationNames.get(id))
        .filter(Boolean)
    };
  }

  /**
   * Fuzzy + exact product search, with optional classification filters
   * (Phase 4C).
   *
   * Per the approved Phase 4A contract: does not call the domain search
   * function for an empty/whitespace-only query with no active filters --
   * returns the same empty shape immediately, without loading products or
   * classification data at all (no repository calls at all in that case).
   *
   * Phase 4C addition: an empty query WITH active filters is a valid,
   * distinct case -- "filters only." Filters are always applied to the
   * active product list first (Phase 4C approved pipeline), regardless of
   * whether a text query follows. When the query is empty, Fuse is never
   * invoked and the filtered product list becomes `matches` directly;
   * `related` stays [] and `hasExactMatch` stays false -- the SAME public
   * result shape as a normal search, not a second shape the caller must
   * branch on.
   *
   * Archived products are excluded (same default as listProducts()/
   * productRepository.list()), independent of filter state.
   *
   * @param {string} query
   * @param {{ categoryId?: string|null, locationIds?: string[], tagIds?: string[] }} [filters]
   * @returns {Promise<{ matches: object[], related: object[], hasExactMatch: boolean }>}
   */
  async function searchProductsUseCase(query, filters = {}) {
    const queryIsEmpty = isEmptyQuery(query);
    const hasActiveFilters = Boolean(
      filters.categoryId || (filters.locationIds && filters.locationIds.length > 0) || (filters.tagIds && filters.tagIds.length > 0)
    );

    if (queryIsEmpty && !hasActiveFilters) {
      return { matches: [], related: [], hasExactMatch: false };
    }

    const allActiveProducts = await productRepository.list({ includeArchived: false });
    const filteredProducts = applyFilters(allActiveProducts, filters);

    if (queryIsEmpty) {
      // Filters-only: Fuse is never invoked, but the public result
      // contract stays identical to a normal search result (Phase 4C
      // locked decision -- no second shape for callers to branch on).
      return { matches: filteredProducts, related: [], hasExactMatch: false };
    }

    const [categoryNames, locationNames, tagNames] = await Promise.all([
      buildNameMap('category'),
      buildNameMap('location'),
      buildNameMap('tag')
    ]);

    const searchableProducts = filteredProducts.map((product) =>
      toSearchableProduct(product, categoryNames, locationNames, tagNames)
    );

    return domainSearchProducts(searchableProducts, query);
  }

  return {
    listProducts,
    getProduct,
    createProduct: createProductUseCase,
    updateProduct: updateProductUseCase,
    searchProducts: searchProductsUseCase
  };
}
