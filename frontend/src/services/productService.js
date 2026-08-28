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
  // searchProducts (Phase 4A)
  // ---------------------------------------------------------------------------

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
   * Fuzzy + exact product search.
   *
   * Per the approved Phase 4A contract: does not call the domain search
   * function for an empty/whitespace-only query -- returns the same empty
   * shape immediately, without loading products or classification data at
   * all (no repository calls for an empty query).
   *
   * Archived products are excluded (same default as listProducts()/
   * productRepository.list()).
   *
   * @param {string} query
   * @returns {Promise<{ matches: object[], related: object[], hasExactMatch: boolean }>}
   */
  async function searchProductsUseCase(query) {
    if (isEmptyQuery(query)) {
      return { matches: [], related: [], hasExactMatch: false };
    }

    const products = await productRepository.list({ includeArchived: false });

    const [categoryNames, locationNames, tagNames] = await Promise.all([
      buildNameMap('category'),
      buildNameMap('location'),
      buildNameMap('tag')
    ]);

    const searchableProducts = products.map((product) =>
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
