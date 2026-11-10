// Redesign R6: the hook also publishes the mobile bar's OWN height
// (--chrome-bottom-nav, no gap), which the stock-action bar and the undo notice
// are offset by. Rectangles are supplied by the test (jsdom does no layout);
// that the stacking really lines up was verified in a real browser.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useFixedChromeInsets } from './useFixedChromeInsets.js';

const BAR = '[data-mobile-bar="true"]';

function Harness({ bar = 'fixed' }) {
  const ref = useRef(null);
  useFixedChromeInsets(ref);
  return (
    <div ref={ref}>
      <header>head</header>
      <nav data-mobile-bar="true" style={{ position: bar === 'fixed' ? 'fixed' : 'static' }}>
        bar
      </nav>
    </div>
  );
}

const root = document.documentElement;
const value = (name) => root.style.getPropertyValue(name);

describe('useFixedChromeInsets: --chrome-bottom-nav', () => {
  let rects;
  let rectSpy;
  beforeEach(() => {
    window.innerHeight = 667;
    rects = { header: { top: 0, bottom: 61, height: 61 }, [BAR]: { top: 618, bottom: 667, height: 49 } };
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const found = Object.entries(rects).find(([selector]) => this.matches(selector));
      const r = found ? found[1] : { top: 0, bottom: 0, height: 0 };
      return { ...r, left: 0, right: 0, width: 0, x: 0, y: r.top, toJSON() {} };
    });
  });
  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
    for (const name of ['--chrome-top', '--chrome-bottom', '--chrome-bottom-nav']) root.style.removeProperty(name);
  });

  it('publishes the bar\'s own measured height, without the gap that --chrome-bottom adds', () => {
    render(<Harness />);
    expect(value('--chrome-bottom-nav')).toBe('49px');
    expect(value('--chrome-bottom')).toBe('57px'); // 49 + the 8px gap, unchanged
  });

  it('follows the bar when it grows (enlarged text wraps its labels)', () => {
    render(<Harness />);
    rects[BAR] = { top: 560, bottom: 667, height: 107 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(value('--chrome-bottom-nav')).toBe('107px');
  });

  it('is 0 when the nav is not a fixed bar (wide screens render it inline)', () => {
    rects[BAR] = { top: 10, bottom: 60, height: 50 };
    render(<Harness bar="inline" />);
    expect(value('--chrome-bottom-nav')).toBe('0px');
  });

  it('is capped like the other measurements, and cleared on unmount', () => {
    rects[BAR] = { top: -4000, bottom: 0, height: 4000 };
    const view = render(<Harness />);
    expect(value('--chrome-bottom-nav')).toBe('333px');
    view.unmount();
    expect(value('--chrome-bottom-nav')).toBe('');
  });
});
