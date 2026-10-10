import { describe, it, expect } from 'vitest';
import { routeName, formatDocumentTitle } from './routeTitle.js';
import { CLASSIFICATION_TYPES, classificationPath } from '../classificationTypes.js';

describe('routeName', () => {
  it.each([
    ['/', 'Dashboard'],
    ['/products', 'Products'],
    ['/products/', 'Products'],
    ['/products/new', 'Add Product'],
    ['/products/abc-123', 'Product'],
    ['/products/abc-123/edit', 'Edit Product'],
    ['/classifications/categories', 'Categories'],
    ['/classifications/locations', 'Locations'],
    ['/classifications/tags', 'Tags'],
    ['/classifications/units', 'Units'],
    ['/classifications/units/', 'Units']
  ])('%s -> %s', (pathname, expected) => {
    expect(routeName(pathname)).toBe(expected);
  });

  it('every classification route in the app has its own plural name', () => {
    for (const { slug, plural } of CLASSIFICATION_TYPES) {
      expect(routeName(classificationPath(slug))).toBe(plural);
    }
  });

  it.each([
    '/nope',
    '/products/abc/edit/extra',
    '/products/abc/other',
    '/classifications',
    '/classifications/nonsense',
    '/PRODUCTS'
  ])('%s matches no route -> Page not found', (pathname) => {
    expect(routeName(pathname)).toBe('Page not found');
  });
});

describe('formatDocumentTitle', () => {
  it('appends the app name', () => {
    expect(formatDocumentTitle('Products')).toBe('Products \u2014 ShopStock');
  });
});
