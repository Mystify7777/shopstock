// The four classification types managed under /classifications (Phase 7C).
//
//   type       value used by classificationRepository / classificationService
//   slug       URL segment: /classifications/<slug>
//   singular   lower-case noun used in sentences
//   plural     heading / nav label
//   removable  whether "Remove" (fallback on products, then archive) exists.
//              Units are NOT removable: the domain defines no unit fallback.

export const CLASSIFICATION_TYPES = Object.freeze([
  Object.freeze({ type: 'category', slug: 'categories', singular: 'category', plural: 'Categories', removable: true }),
  Object.freeze({ type: 'location', slug: 'locations', singular: 'location', plural: 'Locations', removable: true }),
  Object.freeze({ type: 'tag', slug: 'tags', singular: 'tag', plural: 'Tags', removable: true }),
  Object.freeze({ type: 'unit', slug: 'units', singular: 'unit', plural: 'Units', removable: false })
]);

export function classificationPath(slug) {
  return `/classifications/${slug}`;
}
