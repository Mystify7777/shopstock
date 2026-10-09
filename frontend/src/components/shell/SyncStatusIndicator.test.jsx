import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AppProvider } from '../../contexts/AppContext.jsx';
import SyncStatusSlot from './SyncStatusSlot.jsx';
import SyncStatusIndicator from './SyncStatusIndicator.jsx';

function renderIndicator({ online = true } = {}) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(online);
  let emit;
  let fail;
  const syncStatus = {
    observeSyncStatus: (onChange, onError) => {
      emit = onChange;
      fail = onError;
      return () => {};
    }
  };
  const view = render(
    <AppProvider services={{ syncStatus }}>
      <SyncStatusSlot>
        <SyncStatusIndicator />
      </SyncStatusSlot>
    </AppProvider>
  );
  const slot = () => view.container.querySelector('[data-shell-slot="sync-status"]');
  return {
    slot,
    push: (counts) => act(() => emit(counts)),
    fail: (error) => act(() => fail(error))
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncStatusIndicator', () => {
  it('shows nothing (empty slot) when online with nothing waiting or failed', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 0, failedCount: 0 });
    expect(slot()).toBeEmptyDOMElement();
  });

  it('Pending: states the label and a count in words (plural)', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 3, failedCount: 0 });
    expect(slot()).toHaveTextContent('Pending 3 changes waiting to sync.');
    expect(slot().querySelector('.sync-status--pending')).not.toBeNull();
  });

  it('Pending: singular wording for one change', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 1, failedCount: 0 });
    expect(slot()).toHaveTextContent('Pending 1 change waiting to sync.');
  });

  it('Needs attention: failed changes, in words, non-interactive, no raw error', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 0, failedCount: 2 });
    expect(slot()).toHaveTextContent('Needs attention 2 changes couldn\u2019t be synced.');
    expect(slot().querySelector('.sync-status--attention')).not.toBeNull();
    // exposes the state; offers no action
    expect(slot().querySelector('button, a, input')).toBeNull();
  });

  it('Needs attention: singular wording for one change', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 0, failedCount: 1 });
    expect(slot()).toHaveTextContent('Needs attention 1 change couldn\u2019t be synced.');
  });

  it('Needs attention outranks Pending', () => {
    const { slot, push } = renderIndicator();
    push({ pendingCount: 4, failedCount: 1 });
    expect(slot()).toHaveTextContent('Needs attention');
    expect(slot()).not.toHaveTextContent('Pending');
  });

  it('Offline: hedged wording (a browser hint) and it outranks everything', () => {
    const { slot, push } = renderIndicator({ online: false });
    push({ pendingCount: 4, failedCount: 2 });
    expect(slot()).toHaveTextContent('Offline You appear to be offline.');
    expect(slot()).not.toHaveTextContent('Needs attention');
    expect(slot()).not.toHaveTextContent('Pending');
    expect(slot().querySelector('.sync-status--offline')).not.toBeNull();
  });

  it('updates live when the queue drains or the browser reconnects', () => {
    const { slot, push } = renderIndicator({ online: true });
    push({ pendingCount: 2, failedCount: 0 });
    expect(slot()).toHaveTextContent('Pending');

    push({ pendingCount: 0, failedCount: 0 });
    expect(slot()).toBeEmptyDOMElement();

    act(() => window.dispatchEvent(new Event('offline')));
    expect(slot()).toHaveTextContent('Offline');

    act(() => window.dispatchEvent(new Event('online')));
    expect(slot()).toBeEmptyDOMElement();
  });

  describe('observation failure', () => {
    it('before any reading: "Sync status unavailable", never an empty (idle) slot', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { slot, fail } = renderIndicator();
      expect(slot()).toBeEmptyDOMElement(); // nothing read, nothing failed
      fail(new Error('idb exploded: secret detail'));
      expect(slot()).toHaveTextContent('Sync status unavailable');
      expect(slot()).toHaveTextContent('Changes are still saved on this device.');
      expect(slot().querySelector('.sync-status--unavailable')).not.toBeNull();
    });

    it('after counts were received: replaces them instead of leaving stale text or going idle', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { slot, push, fail } = renderIndicator();
      push({ pendingCount: 3, failedCount: 1 });
      expect(slot()).toHaveTextContent('Needs attention');

      fail(new Error('idb exploded'));
      expect(slot()).toHaveTextContent('Sync status unavailable');
      expect(slot()).not.toHaveTextContent('Needs attention');
      expect(slot()).not.toHaveTextContent('Pending');
    });

    it('never renders the raw exception text and offers no action', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { slot, fail } = renderIndicator();
      fail(new Error('idb exploded: secret detail'));
      expect(slot()).not.toHaveTextContent('idb exploded');
      expect(slot()).not.toHaveTextContent('secret detail');
      expect(slot().querySelector('button, a, input')).toBeNull();
    });

    it('offline outranks unavailable', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { slot, fail } = renderIndicator({ online: false });
      fail(new Error('idb exploded'));
      expect(slot()).toHaveTextContent('Offline');
      expect(slot()).not.toHaveTextContent('Sync status unavailable');
    });

    it('a later successful reading replaces the message with the real state', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { slot, push, fail } = renderIndicator();
      fail(new Error('idb exploded'));
      expect(slot()).toHaveTextContent('Sync status unavailable');

      push({ pendingCount: 0, failedCount: 0 });
      expect(slot()).toBeEmptyDOMElement();
    });
  });

  it('the slot is a persistent polite live region', () => {
    const { slot } = renderIndicator();
    expect(slot()).toHaveAttribute('aria-live', 'polite');
  });
});
