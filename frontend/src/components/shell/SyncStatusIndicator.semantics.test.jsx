// Redesign R2: the sync status is INFORMATIONAL. Rendered, in every visible
// state, it contains nothing a user could operate, keeps its existing words, and
// stays a polite (not alert) live region. Class/variant mapping is presentation
// only and is pinned here so the visual change cannot drift from the contract.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { AppProvider } from '../../contexts/AppContext.jsx';
import { captureConsoleError } from '../../../tests/helpers/captureConsoleError.js';
import SyncStatusSlot from './SyncStatusSlot.jsx';
import SyncStatusIndicator from './SyncStatusIndicator.jsx';

const INTERACTIVE =
  'button, a, input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [role="alert"]';

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

// state -> [existing words that must remain, notice variant, state class]
const CASES = [
  {
    name: 'pending',
    setup: (h) => h.push({ pendingCount: 24, failedCount: 0 }),
    text: ['Pending', '24 changes waiting to sync.'],
    variant: 'info'
  },
  {
    name: 'attention',
    setup: (h) => h.push({ pendingCount: 0, failedCount: 2 }),
    text: ['Needs attention', '2 changes couldn\u2019t be synced.'],
    variant: 'danger'
  },
  {
    name: 'offline',
    online: false,
    setup: () => {},
    text: [
      'Offline',
      'You appear to be offline. Changes are saved on this device and will sync later.'
    ],
    variant: 'neutral'
  },
  {
    name: 'unavailable',
    setup: (h) => {
      const consoleError = captureConsoleError('Reading the sync status failed.');
      h.fail(new Error('queue read failed'));
      expect(consoleError).toHaveBeenCalledTimes(1);
    },
    text: ['Sync status unavailable', 'Changes are still saved on this device.'],
    variant: 'neutral'
  }
];

describe.each(CASES)('sync status: $name', ({ name, online = true, setup, text, variant }) => {
  function show() {
    const h = renderIndicator({ online });
    setup(h);
    return h.slot();
  }

  it('keeps its existing words', () => {
    const slot = show();
    for (const words of text) expect(slot.textContent).toContain(words);
  });

  it('contains no interactive control and no assertive alert semantics', () => {
    const slot = show();
    expect(slot.querySelector(`.sync-status--${name}`)).not.toBeNull();
    expect(slot.querySelectorAll(INTERACTIVE)).toHaveLength(0);
  });

  it(`wears the ${variant} notice and keeps its sync-status state class`, () => {
    const el = show().querySelector(`.sync-status--${name}`);
    expect(el).toHaveClass('notice', `notice--${variant}`, 'sync-status');
  });

  it('stays inside the persistent polite live region', () => {
    const slot = show();
    expect(slot).toHaveAttribute('aria-live', 'polite');
    expect(slot).not.toHaveAttribute('role', 'alert');
  });
});

it('renders nothing at all when idle (no empty notice box)', () => {
  const h = renderIndicator();
  h.push({ pendingCount: 0, failedCount: 0 });
  expect(h.slot().querySelector('.notice, .sync-status')).toBeNull();
  expect(h.slot()).toBeEmptyDOMElement();
});
