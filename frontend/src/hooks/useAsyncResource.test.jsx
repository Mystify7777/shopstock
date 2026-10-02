import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAsyncResource } from './useAsyncResource.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAsyncResource', () => {
  it('starts loading, then succeeds with the data', async () => {
    const { result } = renderHook(() => useAsyncResource(() => Promise.resolve('hello')));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('hello');
    expect(result.current.error).toBeNull();
  });

  it('reports a failure', async () => {
    const boom = new Error('boom');
    const { result } = renderHook(() => useAsyncResource(() => Promise.reject(boom)));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(boom);
  });

  it('retries after a failure with reload()', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useAsyncResource(loader));
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shows loading (not stale data) when a first load is retried', async () => {
    const second = deferred();
    const loader = vi.fn().mockRejectedValueOnce(new Error('x')).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAsyncResource(loader));
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('loading'));
    await act(async () => second.resolve('done'));
    expect(result.current.data).toBe('done');
  });

  it('keeps the previous data visible while reloading', async () => {
    const second = deferred();
    const loader = vi.fn().mockResolvedValueOnce('first').mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAsyncResource(loader));
    await waitFor(() => expect(result.current.data).toBe('first'));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.isReloading).toBe(true));
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('first');

    await act(async () => second.resolve('second'));
    expect(result.current.data).toBe('second');
    expect(result.current.isReloading).toBe(false);
  });

  it('reloads when its dependencies change', async () => {
    const loader = vi.fn((id) => Promise.resolve(`item-${id}`));
    const { result, rerender } = renderHook(({ id }) => useAsyncResource(() => loader(id), [id]), {
      initialProps: { id: 1 }
    });
    await waitFor(() => expect(result.current.data).toBe('item-1'));
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.data).toBe('item-2'));
  });

  it('ignores a stale response that arrives after the dependencies changed', async () => {
    const slow = deferred();
    const loader = vi.fn((id) => (id === 1 ? slow.promise : Promise.resolve('fresh')));
    const { result, rerender } = renderHook(({ id }) => useAsyncResource(() => loader(id), [id]), {
      initialProps: { id: 1 }
    });
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.data).toBe('fresh'));

    await act(async () => slow.resolve('stale'));
    expect(result.current.data).toBe('fresh');
  });

  it('does not update state after unmount', async () => {
    const pending = deferred();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useAsyncResource(() => pending.promise));
    unmount();
    await act(async () => pending.resolve('late'));
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
