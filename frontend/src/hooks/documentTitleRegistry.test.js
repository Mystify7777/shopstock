import { describe, it, expect, beforeEach } from 'vitest';
import { claimTitle, TITLE_PRIORITY } from './documentTitleRegistry.js';

const { ROUTE, OVERLAY } = TITLE_PRIORITY;

beforeEach(() => {
  document.title = 'Original';
});

describe('documentTitleRegistry', () => {
  it('shows a claimed title and restores the original when the last claim is released', () => {
    const claim = claimTitle('A', ROUTE);
    expect(document.title).toBe('A');
    claim.release();
    expect(document.title).toBe('Original');
  });

  it('a claim can change its title while held', () => {
    const claim = claimTitle('A', ROUTE);
    claim.update('B');
    expect(document.title).toBe('B');
    claim.release();
  });

  it('the higher priority wins regardless of claim order', () => {
    const overlay = claimTitle('Sign in', OVERLAY);
    const route = claimTitle('Products', ROUTE);
    expect(document.title).toBe('Sign in');
    route.release();
    overlay.release();
  });

  it('among equal priorities the most recent claim wins', () => {
    const first = claimTitle('First', ROUTE);
    const second = claimTitle('Second', ROUTE);
    expect(document.title).toBe('Second');
    second.release();
    expect(document.title).toBe('First');
    first.release();
  });

  it('a lower-priority update does not disturb the visible higher-priority title', () => {
    const route = claimTitle('Products', ROUTE);
    const overlay = claimTitle('Sign in', OVERLAY);
    route.update('Product');
    expect(document.title).toBe('Sign in');
    overlay.release();
    overlay.release(); // releasing twice is harmless
    expect(document.title).toBe('Product');
    route.release();
  });

  it('releasing a higher claim reveals the CURRENT title of the one below, not a stale snapshot', () => {
    const route = claimTitle('Products', ROUTE);
    const overlay = claimTitle('Sign in', OVERLAY);
    route.update('Add Product');
    route.update('Edit Product');
    overlay.release();
    expect(document.title).toBe('Edit Product');
    route.release();
    expect(document.title).toBe('Original');
  });

  it('releasing in any order ends back at the original title', () => {
    const a = claimTitle('A', ROUTE);
    const b = claimTitle('B', OVERLAY);
    a.release();
    expect(document.title).toBe('B');
    b.release();
    expect(document.title).toBe('Original');
  });
});

describe('every release order (checked against a reference model)', () => {
  function permutations(items) {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
    );
  }

  // Reference model: highest priority wins, ties go to the latest claim.
  function expectedTitle(held) {
    if (held.length === 0) return 'Original';
    let top = held[0];
    for (const c of held) if (c.priority >= top.priority) top = c;
    return top.title;
  }

  const specs = [
    { title: 'Route', priority: ROUTE },
    { title: 'Overlay', priority: OVERLAY },
    { title: 'Route 2', priority: ROUTE },
    { title: 'Overlay 2', priority: OVERLAY }
  ];

  it.each(permutations([0, 1, 2, 3]).map((order) => [order.join('-'), order]))(
    'release order %s ends at the original title and matches the model after every step',
    (_label, order) => {
      const claims = specs.map((spec) => ({ ...spec, handle: claimTitle(spec.title, spec.priority) }));
      expect(document.title).toBe(expectedTitle(claims));

      let held = [...claims];
      for (const index of order) {
        claims[index].handle.release();
        held = held.filter((c) => c !== claims[index]);
        expect(document.title).toBe(expectedTitle(held));
      }
      expect(document.title).toBe('Original');
    }
  );

  it('a title update on a held claim is reflected in the same models', () => {
    const route = claimTitle('Products', ROUTE);
    const overlay = claimTitle('Sign in', OVERLAY);
    route.update('Product');
    overlay.release();
    expect(document.title).toBe('Product');
    route.release();
    expect(document.title).toBe('Original');
  });
});
