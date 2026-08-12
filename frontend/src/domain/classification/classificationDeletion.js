// Classification deletion — category/location/tag fallback rules.
//
// Scope, deliberately narrow: this file answers two questions for a
// pending category/location/tag deletion —
//   (1) which products are affected?
//   (2) what does each affected product look like AFTER the deletion's
//       fallback rule is applied?
// — and does NOTHING ELSE. In particular, this file does NOT:
//   - delete or archive any product (PRD §10/§11: "the system must never
//     interpret 'delete category' as 'delete every product using this
//     category' without explicit confirmation" — that confirmation and
//     any resulting product deletion belongs to the service/UI layer)
//   - persist anything (no IndexedDB, no MongoDB)
//   - decide the classification (category/location/tag) itself no longer
//     exists — this file assumes that decision has already been made by
//     the caller and just computes the product-side consequences
//   - show any confirmation UI, or count-affected-products messaging —
//     it just RETURNS the count/list so a caller can build that UI
//
// THE THREE DIFFERENT FALLBACK SEMANTICS (PRD §7/§8/§10, Build Brief
// §8/§9/§10) — these are genuinely different operations, not one generic
// "remove a reference" helper with a type flag threaded through:
//
//   CATEGORY  (single reference): categoryId -> null (displayed as
//             "Uncategorized" by the UI layer — this file just nulls the
//             field; the fallback LABEL is a presentation concern).
//   LOCATION  (array reference):  the specific locationId is removed from
//             locationIds; every other location the product has stays.
//   TAG       (array reference):  the specific tagId is removed from
//             tagIds; every other tag the product has stays.
//
// Modeling these as three distinct functions (rather than one function
// with a `type` switch) keeps each transformation's contract simple and
// makes it impossible to accidentally apply the array-removal logic to a
// single-reference field or vice versa.

/**
 * Which products currently reference this category?
 *
 * @param {object[]} products
 * @param {string} categoryId
 * @returns {object[]} The subset of products whose categoryId matches.
 */
export function findProductsUsingCategory(products, categoryId) {
  const list = Array.isArray(products) ? products : [];
  return list.filter((p) => p && p.categoryId === categoryId);
}

/**
 * Which products currently reference this location?
 *
 * @param {object[]} products
 * @param {string} locationId
 * @returns {object[]} The subset of products whose locationIds includes
 *   locationId. A product is counted once even if (implausibly)
 *   locationId appeared more than once in its own array — this returns
 *   PRODUCTS, not reference occurrences.
 */
export function findProductsUsingLocation(products, locationId) {
  const list = Array.isArray(products) ? products : [];
  return list.filter(
    (p) => p && Array.isArray(p.locationIds) && p.locationIds.includes(locationId)
  );
}

/**
 * Which products currently reference this tag?
 *
 * @param {object[]} products
 * @param {string} tagId
 * @returns {object[]} The subset of products whose tagIds includes tagId.
 *   Same one-product-once counting note as findProductsUsingLocation.
 */
export function findProductsUsingTag(products, tagId) {
  const list = Array.isArray(products) ? products : [];
  return list.filter((p) => p && Array.isArray(p.tagIds) && p.tagIds.includes(tagId));
}

/**
 * Apply the CATEGORY deletion fallback to one product: the reference
 * becomes null (displayed by the UI as "Uncategorized," per PRD §7).
 * A no-op (returns an equivalent product) if the product didn't reference
 * this category in the first place.
 *
 * @param {object} product
 * @param {string} categoryId The category being deleted.
 * @returns {object} A NEW product object with categoryId cleared if it
 *   matched; the original product is never mutated.
 */
export function applyCategoryDeletionFallback(product, categoryId) {
  if (!product || typeof product !== 'object') {
    throw new TypeError('applyCategoryDeletionFallback requires a product.');
  }
  if (product.categoryId !== categoryId) {
    return { ...product };
  }
  return { ...product, categoryId: null };
}

/**
 * Apply the LOCATION deletion fallback to one product: the specific
 * locationId is removed from locationIds; every other location reference
 * is preserved untouched. If removing it empties the array, the array
 * simply becomes `[]` — "Location unspecified" (PRD §8) is a presentation
 * fallback for an empty array, not a value this function writes.
 *
 * @param {object} product
 * @param {string} locationId The location being deleted.
 * @returns {object} A NEW product object with locationId removed from
 *   locationIds if present; the original product/array is never mutated.
 */
export function applyLocationDeletionFallback(product, locationId) {
  if (!product || typeof product !== 'object') {
    throw new TypeError('applyLocationDeletionFallback requires a product.');
  }
  const locationIds = Array.isArray(product.locationIds) ? product.locationIds : [];
  return {
    ...product,
    locationIds: locationIds.filter((id) => id !== locationId)
  };
}

/**
 * Apply the TAG deletion fallback to one product: the specific tagId is
 * removed from tagIds; every other tag reference is preserved untouched.
 * Tags have no fallback value (PRD §9) — an empty tagIds array is simply
 * "no tags," nothing is substituted in.
 *
 * @param {object} product
 * @param {string} tagId The tag being deleted.
 * @returns {object} A NEW product object with tagId removed from tagIds
 *   if present; the original product/array is never mutated.
 */
export function applyTagDeletionFallback(product, tagId) {
  if (!product || typeof product !== 'object') {
    throw new TypeError('applyTagDeletionFallback requires a product.');
  }
  const tagIds = Array.isArray(product.tagIds) ? product.tagIds : [];
  return {
    ...product,
    tagIds: tagIds.filter((id) => id !== tagId)
  };
}

const FALLBACK_APPLIERS = Object.freeze({
  category: applyCategoryDeletionFallback,
  location: applyLocationDeletionFallback,
  tag: applyTagDeletionFallback
});

const PRODUCT_FINDERS = Object.freeze({
  category: findProductsUsingCategory,
  location: findProductsUsingLocation,
  tag: findProductsUsingTag
});

/**
 * Compute the full preview of a pending classification deletion: which
 * products are affected, and what each would look like after the
 * appropriate fallback is applied — WITHOUT deleting, persisting, or
 * confirming anything. This is the one function a service/UI layer needs
 * to build the PRD §10/§11 confirmation screen ("42 products currently
 * use this category").
 *
 * This function does NOT reject an unknown classificationType silently —
 * it throws, so a caller can't accidentally "guess" a fallback behavior
 * for a type this file doesn't know about.
 *
 * @param {'category'|'location'|'tag'} classificationType
 * @param {string} classificationId The id being deleted.
 * @param {object[]} products All products to check (the caller decides
 *   whether that's "all products" or some pre-filtered subset — this
 *   function doesn't know or care about archived state, etc.).
 * @returns {{
 *   classificationType: string,
 *   classificationId: string,
 *   affectedCount: number,
 *   affectedProducts: object[],
 *   updatedProducts: object[]
 * }}
 *   affectedProducts — the ORIGINAL product objects that reference this
 *     classification (for display: "here's what would be affected").
 *   updatedProducts  — NEW product objects (same order, same length as
 *     affectedProducts) with the fallback already applied — what each
 *     product WOULD look like if the caller proceeds with "remove the
 *     field, keep the products" (PRD §10). None of these are persisted by
 *     this function.
 *   affectedCount    — affectedProducts.length, provided directly so a
 *     caller doesn't need to re-derive it.
 */
export function previewClassificationDeletion(classificationType, classificationId, products) {
  const finder = PRODUCT_FINDERS[classificationType];
  const applier = FALLBACK_APPLIERS[classificationType];

  if (!finder || !applier) {
    throw new TypeError(
      `Unknown classification type "${classificationType}". Expected "category", "location", or "tag".`
    );
  }
  if (typeof classificationId !== 'string' || classificationId.trim().length === 0) {
    throw new TypeError('previewClassificationDeletion requires a classificationId.');
  }

  const affectedProducts = finder(products, classificationId);
  const updatedProducts = affectedProducts.map((product) => applier(product, classificationId));

  return {
    classificationType,
    classificationId,
    affectedCount: affectedProducts.length,
    affectedProducts,
    updatedProducts
  };
}
