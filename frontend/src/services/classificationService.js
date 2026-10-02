// Classification service (Phase 7C).
//
// A THIN orchestration layer over capabilities that already exist:
//   - classificationRepository  (list / getById / create / update)
//   - productService            (listProducts / getProduct / updateProduct)
//   - previewClassificationDeletion() from the classification domain
//
// It invents NO classification rules. In particular it does not:
//   - enforce unique names (the repository and backend have no such rule)
//   - seed default classifications, or give `isDefault` any behavior
//     (new records are created with isDefault: false, like any other
//     persisted data this phase never interprets)
//   - define "affected product": that is exactly what
//     previewClassificationDeletion() computes over the products handed to
//     it. This service hands it EVERY product (active and archived), so no
//     product is left holding a reference to a removed classification.
//   - define unit removal: the domain has no unit fallback, so removal
//     is refused for units.
//
// REMOVAL IS NOT ATOMIC. Each product update is its own transaction; there
// is no transaction spanning N products. removeWithFallback() therefore:
//   1. updates affected products first, one at a time, recording failures;
//   2. archives the classification ONLY if every product update succeeded;
//   3. reports exactly what happened (completed | partial | archive-failed).
// If anything fails the classification stays ACTIVE and products already
// updated stay updated. Retrying is safe and explicit: call
// removeWithFallback() again. Products already fixed no longer reference
// the classification, so a retry only touches what is still outstanding.

import { generateId } from '../domain/shared/ids.js';
import { previewClassificationDeletion } from '../domain/classification/classificationDeletion.js';
import { ClassificationNotFoundError } from '../data/repositories/classificationRepository.js';

export class ClassificationRemovalNotSupportedError extends Error {
  constructor(type) {
    super(
      type === 'unit'
        ? 'Units cannot be removed. They can be archived instead.'
        : `Removal is not supported for classification type "${type}".`
    );
    this.name = 'ClassificationRemovalNotSupportedError';
    this.classificationType = type;
  }
}

// Which Product field each removable type lives in (mirrors the three
// distinct fallback semantics in classificationDeletion.js).
const PRODUCT_FIELD_FOR_TYPE = Object.freeze({
  category: 'categoryId',
  location: 'locationIds',
  tag: 'tagIds'
});

function assertRemovable(type) {
  if (!Object.hasOwn(PRODUCT_FIELD_FOR_TYPE, type)) {
    throw new ClassificationRemovalNotSupportedError(type);
  }
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return ['Name is required.'];
  }
  return [];
}

function productLabel(product) {
  return typeof product.name === 'string' && product.name.trim() !== ''
    ? product.name.trim()
    : 'Unnamed product';
}

/**
 * @param {object} classificationRepository Result of createClassificationRepository(db).
 * @param {object} productService Result of createProductService(...).
 * @throws {TypeError} If either dependency is missing.
 */
export function createClassificationService(classificationRepository, productService) {
  if (!classificationRepository) {
    throw new TypeError('createClassificationService() requires a classificationRepository.');
  }
  if (!productService) {
    throw new TypeError('createClassificationService() requires a productService.');
  }

  /**
   * @param {'category'|'location'|'tag'|'unit'} type
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {Promise<object[]>}
   */
  async function list(type, options = {}) {
    return classificationRepository.list(type, options);
  }

  /**
   * Create a classification. The name is trimmed; a blank name is refused
   * (the backend rejects blank names, which would fail sync permanently).
   *
   * @returns {Promise<{ classification: object|null, errors: string[] }>}
   *   If errors is non-empty nothing was persisted.
   */
  async function create(type, name) {
    const errors = validateName(name);
    if (errors.length > 0) return { classification: null, errors };

    const classification = {
      id: generateId(),
      name: name.trim(),
      archived: false,
      isDefault: false
    };
    await classificationRepository.create(type, classification);
    return { classification, errors: [] };
  }

  /**
   * Rename a classification. Renaming to the identical (trimmed) name is a
   * no-op: nothing is written and nothing is queued for sync.
   *
   * @returns {Promise<{ classification: object|null, errors: string[] }>}
   */
  async function rename(type, id, name) {
    const errors = validateName(name);
    if (errors.length > 0) return { classification: null, errors };

    const existing = await classificationRepository.getById(type, id);
    if (!existing) return { classification: null, errors: ['That item no longer exists.'] };

    const trimmed = name.trim();
    if (existing.name === trimmed) return { classification: existing, errors: [] };

    const updated = { ...existing, name: trimmed };
    await classificationRepository.update(type, updated);
    return { classification: updated, errors: [] };
  }

  async function setArchived(type, id, archived) {
    const existing = await classificationRepository.getById(type, id);
    if (!existing) return { classification: null, errors: ['That item no longer exists.'] };
    if (existing.archived === archived) return { classification: existing, errors: [] };

    const updated = { ...existing, archived };
    await classificationRepository.update(type, updated);
    return { classification: updated, errors: [] };
  }

  /** Archive: reversible and non-destructive; products keep their references. */
  function archive(type, id) {
    return setArchived(type, id, true);
  }

  /** Restore an archived classification. */
  function restore(type, id) {
    return setArchived(type, id, false);
  }

  /**
   * What removing this category/location/tag would affect. Read-only: it
   * persists nothing.
   *
   * @returns {Promise<{
   *   classification: object,
   *   affectedCount: number,
   *   affectedProducts: object[],
   *   archivedAffectedCount: number
   * }>} affectedCount / affectedProducts are exactly
   *   previewClassificationDeletion()'s, computed over ALL products.
   *   archivedAffectedCount says how many of them are archived products.
   * @throws {ClassificationRemovalNotSupportedError} For units / unknown types.
   * @throws {ClassificationNotFoundError} If the classification does not exist.
   */
  async function previewRemoval(type, id) {
    assertRemovable(type);
    const classification = await classificationRepository.getById(type, id);
    if (!classification) throw new ClassificationNotFoundError(type, id);

    const products = await productService.listProducts({ includeArchived: true });
    const { affectedCount, affectedProducts } = previewClassificationDeletion(type, id, products);

    return {
      classification,
      affectedCount,
      affectedProducts,
      archivedAffectedCount: affectedProducts.filter((p) => p.archived === true).length
    };
  }

  /**
   * Remove a category/location/tag: apply the existing fallback to every
   * affected product, then archive the classification. See the file header
   * for why this is not atomic and how retry works.
   *
   * @returns {Promise<{
   *   status: 'completed' | 'partial' | 'archive-failed',
   *   affectedCount: number,
   *   updatedCount: number,
   *   skippedCount: number,
   *   failures: Array<{ productId: string, productName: string, message: string }>,
   *   archiveError: string|null,
   *   retryable: boolean
   * }>}
   *   completed       every affected product updated, classification archived
   *   partial         some product updates failed; classification still ACTIVE
   *   archive-failed  all products updated but archiving failed; still ACTIVE
   *   skippedCount    products that no longer referenced it when reached
   *                   (e.g. fixed by an earlier attempt)
   * @throws {ClassificationRemovalNotSupportedError} For units / unknown types.
   * @throws {ClassificationNotFoundError} If the classification does not exist.
   */
  async function removeWithFallback(type, id) {
    assertRemovable(type);
    const classification = await classificationRepository.getById(type, id);
    if (!classification) throw new ClassificationNotFoundError(type, id);

    const field = PRODUCT_FIELD_FOR_TYPE[type];
    const products = await productService.listProducts({ includeArchived: true });
    const { affectedProducts } = previewClassificationDeletion(type, id, products);

    let updatedCount = 0;
    let skippedCount = 0;
    const failures = [];

    for (const listed of affectedProducts) {
      try {
        // Re-read just before writing so a product edited since the list
        // was loaded is not overwritten with stale fields.
        const fresh = await productService.getProduct(listed.id);
        const single = fresh ? previewClassificationDeletion(type, id, [fresh]) : null;
        if (!single || single.affectedCount === 0) {
          skippedCount += 1;
          continue;
        }

        const { errors } = await productService.updateProduct(fresh, {
          [field]: single.updatedProducts[0][field]
        });
        if (errors.length > 0) {
          failures.push({
            productId: listed.id,
            productName: productLabel(listed),
            message: errors.join(' ')
          });
        } else {
          updatedCount += 1;
        }
      } catch (error) {
        failures.push({
          productId: listed.id,
          productName: productLabel(listed),
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const base = {
      affectedCount: affectedProducts.length,
      updatedCount,
      skippedCount,
      failures
    };

    if (failures.length > 0) {
      return { status: 'partial', ...base, archiveError: null, retryable: true };
    }

    // Every product is clean. Only now archive the classification.
    try {
      const current = await classificationRepository.getById(type, id);
      if (current && !current.archived) {
        await classificationRepository.update(type, { ...current, archived: true });
      }
    } catch (error) {
      return {
        status: 'archive-failed',
        ...base,
        archiveError: error instanceof Error ? error.message : String(error),
        retryable: true
      };
    }

    return { status: 'completed', ...base, archiveError: null, retryable: false };
  }

  return {
    list,
    create,
    rename,
    archive,
    restore,
    previewRemoval,
    removeWithFallback
  };
}
