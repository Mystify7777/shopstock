import { CLASSIFICATION_TYPES, classificationPath } from '../classificationTypes.js';

// Route names and document titles (Phase 7H). Pure: pathname in, text out.
//
// Page-level titles only. Pages that load data (a product's detail page)
// get a generic name here; a data-specific title would have to come from
// the page itself and is deliberately not part of this mechanism.

const TITLE_SUFFIX = 'ShopStock';

const CLASSIFICATION_NAMES = new Map(
  CLASSIFICATION_TYPES.map(({ slug, plural }) => [classificationPath(slug), plural])
);

/**
 * The human name of a route, as announced and used in the document title.
 * Anything that matches no route is "Page not found", mirroring the app's
 * catch-all route.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function routeName(pathname) {
  // Ignore a trailing slash so '/products/' and '/products' agree.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (path === '/') return 'Dashboard';
  if (path === '/products') return 'Products';
  if (path === '/products/new') return 'Add Product';
  if (/^\/products\/[^/]+\/edit$/.test(path)) return 'Edit Product';
  if (/^\/products\/[^/]+$/.test(path)) return 'Product';
  if (CLASSIFICATION_NAMES.has(path)) return CLASSIFICATION_NAMES.get(path);
  return 'Page not found';
}

/** "Products" -> "Products \u2014 ShopStock" */
export function formatDocumentTitle(name) {
  return `${name} \u2014 ${TITLE_SUFFIX}`;
}
