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
//
// Does NOT:
//   - import Dexie or create its own database (receives an already-built
//     productRepository)
//   - duplicate product validation (validateProduct() is called exactly
//     once, inside createProduct()/updateProduct())
//   - calculate stock, cost, or margin
//   - implement repository persistence logic

import { createProduct, updateProduct } from '../domain/product/productFactory.js';
import { generateId } from '../domain/shared/ids.js';
import { timestampNow } from '../domain/shared/dates.js';

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
 * Create a product service backed by the given product repository.
 *
 * @param {object} productRepository Result of createProductRepository(db).
 */
export function createProductService(productRepository) {

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

  return {
    listProducts,
    getProduct,
    createProduct: createProductUseCase,
    updateProduct: updateProductUseCase
  };
}
