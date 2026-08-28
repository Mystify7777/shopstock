import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue.js';

describe('useDebouncedValue', () => {
  // Restoring real timers in afterEach (rather than at the end of each
  // test body) guarantees cleanup even if an assertion above it throws --
  // otherwise a failed expect() would leave fake timers installed and
  // leak into whichever test runs next.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 450));
    expect(result.current).toBe('a');
  });

  it('does not update the debounced value before the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 450),
      { initialProps: { value: 'a' } }
    );

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');
  });

  it('updates the debounced value after the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 450),
      { initialProps: { value: 'a' } }
    );

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(result.current).toBe('b');
  });

  it('does not update at exactly one tick before the 450ms threshold', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 450),
      { initialProps: { value: 'a' } }
    );

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(449);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('b');
  });

  it('collapses rapid successive changes into a single final update', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 450),
      { initialProps: { value: 'a' } }
    );

    rerender({ value: 'ab' });
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ value: 'abc' });
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ value: 'abcd' });
    act(() => { vi.advanceTimersByTime(450); });

    expect(result.current).toBe('abcd'); // only the final value, not each intermediate one
  });
});
