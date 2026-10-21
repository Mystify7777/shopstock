import { useEffect } from 'react';

// Space kept between a scrolled-to control and the fixed chrome, so its focus
// ring is not flush against the edge.
const GAP_PX = 8;

/**
 * Keeps keyboard focus from being scrolled underneath the app shell's fixed
 * chrome (7H Slice 3).
 *
 * The header is sticky at the top and, on small screens, the primary nav is a
 * bar fixed to the bottom. When focus moves to a control the browser scrolls it
 * to the nearest edge of the viewport, which is exactly where that chrome sits,
 * so the focused control ends up hidden behind it. This measures the chrome and
 * publishes how much of the top and bottom of the viewport it covers:
 *
 *   --chrome-top      px covered at the top   (the header)
 *   --chrome-bottom   px covered at the bottom (the mobile bar, 0 when absent)
 *
 * on the document element, where the stylesheet turns them into
 * scroll-padding. They are measured, not hard-coded, because those heights
 * change with text size, wrapping and the device's safe-area insets, which is
 * the situation keyboard users who enlarge text are in.
 *
 * Only a bar that is actually position: fixed counts; at wide widths the same
 * nav sits inline in the header and covers nothing.
 *
 * Plain DOM measurement is enough: the bar is anchored to the layout viewport
 * and an on-screen keyboard covers it rather than moving it, so the
 * visualViewport API would add nothing here.
 *
 * @param {{ current: HTMLElement | null }} shellRef the shell's root element
 */
export function useFixedChromeInsets(shellRef) {
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const root = document.documentElement;
    const header = shell.querySelector('header');
    const bar = shell.querySelector('[data-mobile-bar="true"]');

    // scroll-padding larger than the viewport would make scrolling impossible, so
    // a wrong measurement can never be worse than half of it.
    const cap = (px) => Math.min(Math.max(0, px), Math.floor(window.innerHeight / 2));

    function update() {
      const headerBottom = header ? Math.ceil(header.getBoundingClientRect().bottom) : 0;
      root.style.setProperty('--chrome-top', `${cap(headerBottom > 0 ? headerBottom + GAP_PX : 0)}px`);

      // On wide screens the same nav is rendered inline in the header (it is
      // not fixed and covers nothing), so only a FIXED bar counts. Non-zero
      // height alone is not enough to tell the two apart.
      const barRect = bar ? bar.getBoundingClientRect() : null;
      const barIsFixed = Boolean(bar) && getComputedStyle(bar).position === 'fixed' && barRect.height > 0;
      const barCovers = barIsFixed ? Math.ceil(window.innerHeight - barRect.top) : 0;
      root.style.setProperty('--chrome-bottom', `${cap(barCovers > 0 ? barCovers + GAP_PX : 0)}px`);
    }

    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (header) observer?.observe(header);
    if (bar) observer?.observe(bar);
    window.addEventListener('resize', update);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--chrome-top');
      root.style.removeProperty('--chrome-bottom');
    };
  }, [shellRef]);
}
