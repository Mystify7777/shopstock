import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useFixedChromeInsets } from './useFixedChromeInsets.js';

// jsdom performs no layout, so element rectangles are supplied by the test.
// These tests pin how the measurements become the published values and when
// they update or clear. That the resulting scroll-padding really keeps focus
// clear of the chrome was verified in a real browser, not here.

const HEADER = 'header';
const BAR = '[data-mobile-bar="true"]';

function Harness({ withHeader = true, bar = 'fixed' }) {
  const ref = useRef(null);
  useFixedChromeInsets(ref);
  return (
    <div ref={ref}>
      {withHeader && <header>head</header>}
      {bar && (
        <nav data-mobile-bar="true" style={{ position: bar === 'fixed' ? 'fixed' : 'static' }}>
          bar
        </nav>
      )}
    </div>
  );
}

const root = document.documentElement;
const value = (name) => root.style.getPropertyValue(name);

describe('useFixedChromeInsets', () => {
  let rects;
  let rectSpy;
  beforeEach(() => {
    window.innerHeight = 667;
    rects = {
      [HEADER]: { top: 0, bottom: 61, height: 61 },
      [BAR]: { top: 618, bottom: 667, height: 49 }
    };
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const found = Object.entries(rects).find(([selector]) => this.matches(selector));
      const r = found ? found[1] : { top: 0, bottom: 0, height: 0 };
      return { ...r, left: 0, right: 0, width: 0, x: 0, y: r.top, toJSON() {} };
    });
  });
  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
    root.style.removeProperty('--chrome-top');
    root.style.removeProperty('--chrome-bottom');
  });

  it('publishes how much of the top (header) and bottom (fixed bar) of the viewport is covered, plus a small gap', () => {
    render(<Harness />);
    expect(value('--chrome-top')).toBe('69px'); // 61 + 8
    expect(value('--chrome-bottom')).toBe('57px'); // (667 - 618) + 8
  });

  it('a nav that is NOT position: fixed covers nothing, however tall it is (wide screens render it inline in the header)', () => {
    // Regression: "has a non-zero height" was once treated as "is the fixed bar",
    // which published a bottom clearance of almost the whole viewport on desktop.
    rects[BAR] = { top: 10, bottom: 60, height: 50 };
    render(<Harness bar="inline" />);
    expect(value('--chrome-bottom')).toBe('0px');
    expect(value('--chrome-top')).toBe('69px');
  });

  it('a fixed bar that is hidden (zero height) covers nothing', () => {
    rects[BAR] = { top: 667, bottom: 667, height: 0 };
    render(<Harness />);
    expect(value('--chrome-bottom')).toBe('0px');
  });

  it('with no bar (too few nav items for one) the bottom stays at 0', () => {
    render(<Harness bar={null} />);
    expect(value('--chrome-bottom')).toBe('0px');
    expect(value('--chrome-top')).toBe('69px');
  });

  it('with no header the top stays at 0', () => {
    render(<Harness withHeader={false} />);
    expect(value('--chrome-top')).toBe('0px');
  });

  it('a wrong measurement can never exceed half the viewport', () => {
    rects[HEADER] = { top: 0, bottom: 5000, height: 5000 };
    rects[BAR] = { top: -4000, bottom: 0, height: 4000 };
    render(<Harness />);
    expect(value('--chrome-top')).toBe('333px');
    expect(value('--chrome-bottom')).toBe('333px');
  });

  it('follows a window resize', () => {
    render(<Harness />);
    rects[HEADER] = { top: 0, bottom: 100, height: 100 };
    rects[BAR] = { top: 500, bottom: 667, height: 167 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(value('--chrome-top')).toBe('108px');
    expect(value('--chrome-bottom')).toBe('175px');
  });

  it('follows the header or bar changing size without a window resize (ResizeObserver), and stops observing on unmount', () => {
    const observed = [];
    let callback;
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(cb) {
        callback = cb;
      }
      observe(el) {
        observed.push(el.tagName.toLowerCase());
      }
      disconnect() {
        disconnect();
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { unmount } = render(<Harness />);
    expect(observed.sort()).toEqual(['header', 'nav']);

    rects[HEADER] = { top: 0, bottom: 120, height: 120 }; // e.g. text enlarged, header wraps
    act(() => callback());
    expect(value('--chrome-top')).toBe('128px');

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('removes both values on unmount and stops listening for resizes', () => {
    const { unmount } = render(<Harness />);
    expect(value('--chrome-top')).not.toBe('');
    unmount();
    expect(value('--chrome-top')).toBe('');
    expect(value('--chrome-bottom')).toBe('');

    rects[HEADER] = { top: 0, bottom: 300, height: 300 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(value('--chrome-top')).toBe(''); // the listener is gone
  });
});
