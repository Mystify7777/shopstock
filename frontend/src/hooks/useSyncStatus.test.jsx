import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppProvider } from '../contexts/AppContext.jsx';
import { useSyncStatus, deriveSyncState, SYNC_STATE } from './useSyncStatus.js';

// A controllable syncStatus service: the test pushes counts like the real
// observer would.
function makeSyncStatus() {
  let emit = null;
  let fail = null;
  const unsubscribe = vi.fn();
  const service = {
    observeSyncStatus: vi.fn((onChange, onError) => {
      emit = onChange;
      fail = onError;
      return unsubscribe;
    })
  };
  return {
    service,
    unsubscribe,
    push: (counts) => act(() => emit(counts)),
    error: (err) => act(() => fail(err))
  };
}

function mount(syncStatus) {
  return renderHook(() => useSyncStatus(), {
    wrapper: ({ children }) => <AppProvider services={{ syncStatus }}>{children}</AppProvider>
  });
}

function setBrowserOnline(value) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveSyncState (healthy observation: offline > attention > pending > idle)', () => {
  const cases = [
    // online, pending, failed, expected
    [true, 0, 0, SYNC_STATE.IDLE],
    [true, 1, 0, SYNC_STATE.PENDING],
    [true, 0, 1, SYNC_STATE.ATTENTION],
    [true, 3, 2, SYNC_STATE.ATTENTION],
    [false, 0, 0, SYNC_STATE.OFFLINE],
    [false, 2, 0, SYNC_STATE.OFFLINE],
    [false, 0, 2, SYNC_STATE.OFFLINE],
    [false, 2, 2, SYNC_STATE.OFFLINE]
  ];
  it.each(cases)('online=%s pending=%s failed=%s -> %s', (online, pendingCount, failedCount, expected) => {
    expect(deriveSyncState({ online, pendingCount, failedCount })).toBe(expected);
  });
});

describe('deriveSyncState when observation failed (offline > unavailable > the rest)', () => {
  const cases = [
    // online, pending, failed, expected
    [true, 0, 0, SYNC_STATE.UNAVAILABLE],
    [true, 3, 0, SYNC_STATE.UNAVAILABLE],
    [true, 0, 2, SYNC_STATE.UNAVAILABLE],
    [true, 3, 2, SYNC_STATE.UNAVAILABLE],
    [false, 0, 0, SYNC_STATE.OFFLINE],
    [false, 3, 2, SYNC_STATE.OFFLINE]
  ];
  it.each(cases)('online=%s pending=%s failed=%s -> %s', (online, pendingCount, failedCount, expected) => {
    expect(deriveSyncState({ online, pendingCount, failedCount, observationFailed: true })).toBe(expected);
  });

  it('observationFailed defaults to false (healthy)', () => {
    expect(deriveSyncState({ online: true, pendingCount: 0, failedCount: 0 })).toBe(SYNC_STATE.IDLE);
  });
});

describe('useSyncStatus', () => {
  it('starts idle and online with nothing known', () => {
    setBrowserOnline(true);
    const { result } = mount(makeSyncStatus().service);
    expect(result.current).toEqual({ state: 'idle', online: true, pendingCount: 0, failedCount: 0 });
  });

  it('reflects queue counts as they arrive', () => {
    setBrowserOnline(true);
    const sync = makeSyncStatus();
    const { result } = mount(sync.service);

    sync.push({ pendingCount: 2, failedCount: 0 });
    expect(result.current.state).toBe('pending');
    expect(result.current.pendingCount).toBe(2);

    sync.push({ pendingCount: 2, failedCount: 1 });
    expect(result.current.state).toBe('attention');
    expect(result.current.failedCount).toBe(1);

    sync.push({ pendingCount: 0, failedCount: 0 });
    expect(result.current.state).toBe('idle');
  });

  it('starts offline when the browser reports offline', () => {
    setBrowserOnline(false);
    const { result } = mount(makeSyncStatus().service);
    expect(result.current.online).toBe(false);
    expect(result.current.state).toBe('offline');
  });

  it('follows the browser offline and online events', () => {
    setBrowserOnline(true);
    const sync = makeSyncStatus();
    const { result } = mount(sync.service);
    sync.push({ pendingCount: 1, failedCount: 0 });
    expect(result.current.state).toBe('pending');

    act(() => window.dispatchEvent(new Event('offline')));
    expect(result.current.state).toBe('offline');
    // counts are still tracked underneath
    expect(result.current.pendingCount).toBe(1);

    act(() => window.dispatchEvent(new Event('online')));
    expect(result.current.state).toBe('pending');
  });

  describe('observation failure (unknown is not idle)', () => {
    it('an error before the first reading is "unavailable", with unknown (null) counts', () => {
      setBrowserOnline(true);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const sync = makeSyncStatus();
      const { result } = mount(sync.service);
      expect(result.current.state).toBe('idle'); // nothing read yet, nothing failed

      sync.error(new Error('idb exploded'));
      expect(result.current.state).toBe('unavailable');
      expect(result.current.pendingCount).toBeNull();
      expect(result.current.failedCount).toBeNull();
      expect(consoleError).toHaveBeenCalled();
    });

    it('an error after counts were received drops them and reports "unavailable", not idle and not stale', () => {
      setBrowserOnline(true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const sync = makeSyncStatus();
      const { result } = mount(sync.service);
      sync.push({ pendingCount: 4, failedCount: 1 });
      expect(result.current.state).toBe('attention');

      sync.error(new Error('idb exploded'));
      expect(result.current.state).toBe('unavailable');
      expect(result.current.pendingCount).toBeNull();
      expect(result.current.failedCount).toBeNull();
    });

    it('stays unavailable until a real reading arrives, then resumes normal precedence', () => {
      setBrowserOnline(true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const sync = makeSyncStatus();
      const { result } = mount(sync.service);
      sync.error(new Error('idb exploded'));
      expect(result.current.state).toBe('unavailable');

      // time passing or a browser event alone does not clear it
      act(() => window.dispatchEvent(new Event('online')));
      expect(result.current.state).toBe('unavailable');

      sync.push({ pendingCount: 2, failedCount: 0 });
      expect(result.current.state).toBe('pending');
      expect(result.current.pendingCount).toBe(2);
    });

    it('offline still outranks unavailable (the browser fact is still known)', () => {
      setBrowserOnline(true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const sync = makeSyncStatus();
      const { result } = mount(sync.service);
      sync.error(new Error('idb exploded'));
      act(() => window.dispatchEvent(new Event('offline')));
      expect(result.current.state).toBe('offline');
      act(() => window.dispatchEvent(new Event('online')));
      expect(result.current.state).toBe('unavailable');
    });
  });

  it('unsubscribes and removes its listeners on unmount', () => {
    setBrowserOnline(true);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const sync = makeSyncStatus();
    const { unmount } = mount(sync.service);
    unmount();
    expect(sync.unsubscribe).toHaveBeenCalledTimes(1);
    const removed = removeSpy.mock.calls.map(([name]) => name);
    expect(removed).toContain('online');
    expect(removed).toContain('offline');
  });
});
