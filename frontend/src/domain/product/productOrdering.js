// Product list ordering (Phase 7D).
//
// A pure display-order helper. It changes nothing about WHICH products
// are shown (search and filter semantics are untouched) -- only the order
// of an already-selected list that has no relevance order of its own:
// the plain browse list, and filters-only results (empty query).
//
// It must NOT be applied to text-query results: those keep their Fuse
// relevance order.
//
// Why it exists: productRepository.list() returns rows in primary-key
// (UUID) order, which looks random and is useless for scanning a shop's
// inventory.

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function hasName(product) {
  return typeof product.name === 'string' && product.name.trim() !== '';
}

/**
 * Sort products for display: by name ascending, case-insensitive
 * (accents and case are not significant); unnamed products (null, empty or
 * whitespace-only names -- photo-only products) last; ties broken by id so
 * the order is fully deterministic whatever order the input arrives in.
 *
 * @param {object[]} products
 * @returns {object[]} A NEW array. The input array and its products are
 *   not modified.
 * @throws {TypeError} If products is not an array.
 */
export function sortProductsByName(products) {
  if (!Array.isArray(products)) {
    throw new TypeError('sortProductsByName requires an array of products.');
  }

  return [...products].sort((a, b) => {
    const aNamed = hasName(a);
    const bNamed = hasName(b);

    if (aNamed !== bNamed) return aNamed ? -1 : 1;

    if (aNamed) {
      const byName = collator.compare(a.name.trim(), b.name.trim());
      if (byName !== 0) return byName;
    }

    const aId = String(a.id);
    const bId = String(b.id);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
