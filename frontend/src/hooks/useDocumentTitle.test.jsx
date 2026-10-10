import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle.js';

beforeEach(() => {
  document.title = 'Original';
});

describe('useDocumentTitle', () => {
  it('sets the title while mounted and restores the previous one on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Sign in \u2014 ShopStock'));
    expect(document.title).toBe('Sign in \u2014 ShopStock');
    unmount();
    expect(document.title).toBe('Original');
  });

  it('does not reorder against an equal-priority claim when only its title changes', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'First' }
    });
    renderHook(() => useDocumentTitle('Second'));
    expect(document.title).toBe('Second');
    rerender({ title: 'First changed' });
    // 'Second' is still the most recent claim of the same priority.
    expect(document.title).toBe('Second');
  });

  it('follows a changed title', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'A' }
    });
    expect(document.title).toBe('A');
    rerender({ title: 'B' });
    expect(document.title).toBe('B');
  });
});

describe('useDocumentTitle under React StrictMode', () => {
  const strict = ({ children }) => <StrictMode>{children}</StrictMode>;

  it('mounts, cleans up and mounts again without leaking or losing the claim', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Sign in \u2014 ShopStock'), { wrapper: strict });
    expect(document.title).toBe('Sign in \u2014 ShopStock');
    unmount();
    expect(document.title).toBe('Original');
  });

  it('a lower-priority claim never takes over from a higher one across the double effect', () => {
    const overlay = renderHook(() => useDocumentTitle('Sign in'), { wrapper: strict });
    const route = renderHook(() => useDocumentTitle('Products', { priority: 0 }), { wrapper: strict });
    expect(document.title).toBe('Sign in');

    route.rerender();
    expect(document.title).toBe('Sign in');

    overlay.unmount();
    expect(document.title).toBe('Products');
    route.unmount();
    expect(document.title).toBe('Original');
  });

  it('a changed title is applied exactly once, with no stale claim left behind', () => {
    const { rerender, unmount } = renderHook(({ title }) => useDocumentTitle(title), {
      wrapper: strict,
      initialProps: { title: 'A' }
    });
    rerender({ title: 'B' });
    rerender({ title: 'C' });
    expect(document.title).toBe('C');
    unmount();
    expect(document.title).toBe('Original');
  });
});
