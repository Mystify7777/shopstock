// R10 Phase 2: on a phone, opening a stock form asks the browser to bring its
// Save button into view, because on a short page it would otherwise sit under the
// fixed stock-action bar and cover part of its 44px target (measured: 42% of the
// target hittable).
//
// WHAT THIS PROVES: the request is made, for the right button, only when the bar
// is out of the page flow. It fails if the request is removed.
// WHAT IT DOES NOT PROVE: that Save ends up physically clear of the bar. jsdom
// has no layout, so it cannot see the overlap, the root scroll-padding that keeps
// the result above the bar, or the touch flow. That is verified in a real browser
// (see the Phase 2 browser verification), not here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

const PRODUCT = { id: 'p1', name: 'Parle-G', quantity: 10, lowStockThreshold: null, lowStockDisabled: false };

function mount() {
  const productService = {
    listProducts: vi.fn(),
    getProduct: vi.fn().mockResolvedValue(PRODUCT),
    createProduct: vi.fn(),
    updateProduct: vi.fn()
  };
  const stockEventService = {
    getHistory: vi.fn().mockResolvedValue([]),
    getLatestKnownCost: vi.fn().mockResolvedValue(null),
    wouldOverRemove: vi.fn().mockResolvedValue(false),
    addStock: vi.fn(),
    removeStock: vi.fn(),
    reverseEvent: vi.fn()
  };
  return render(
    <AppProvider services={{ productService, stockEventService }}>
      <MemoryRouter initialEntries={['/products/p1']}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

// jsdom loads no stylesheet, so say where the bar is: fixed (phone), absolute
// (phone while a field has focus) or static (wide screen, short viewport).
function stubBarPosition(position) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo);
    if (!element?.classList?.contains('product-detail__actions')) return style;
    return new Proxy(style, {
      get: (target, key) => {
        if (key === 'position') return position;
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  });
}

let reveals;
beforeEach(() => {
  reveals = [];
  Element.prototype.scrollIntoView = function scrollIntoView(options) {
    reveals.push({ element: this, options });
  };
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  vi.restoreAllMocks();
});

describe('Save is revealed when the stock-action bar is out of the page', () => {
  it.each(['fixed', 'absolute'])('opening Add Stock scrolls its Save button into view (bar: %s)', async (position) => {
    stubBarPosition(position);
    mount();
    expect(reveals).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Stock' }));
    const save = within(document.querySelector('#add-stock-form')).getByRole('button', { name: 'Save' });
    expect(reveals).toHaveLength(1);
    expect(reveals[0].element).toBe(save);
  });

  it('opening Remove Stock scrolls its own Save button into view', async () => {
    stubBarPosition('fixed');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Stock' }));
    const save = within(document.querySelector('#remove-stock-form')).getByRole('button', { name: 'Save' });
    expect(reveals).toHaveLength(1);
    expect(reveals[0].element).toBe(save);
  });

  it('asks only for the nearest position and passes no offset of its own', async () => {
    stubBarPosition('fixed');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Stock' }));
    expect(reveals[0].options).toEqual({ block: 'nearest' });
  });

  it('closing the form does not scroll again', async () => {
    stubBarPosition('fixed');
    mount();
    const toggle = await screen.findByRole('button', { name: 'Add Stock' });
    fireEvent.click(toggle); // opens
    expect(document.querySelector('#add-stock-form')).not.toBeNull();
    fireEvent.click(toggle); // closes
    expect(document.querySelector('#add-stock-form')).toBeNull();
    expect(reveals).toHaveLength(1);
  });
});

describe('wide layouts are left alone', () => {
  it.each(['Add Stock', 'Remove Stock'])('with the bar in the page, opening %s does not scroll', async (name) => {
    stubBarPosition('static');
    mount();
    fireEvent.click(await screen.findByRole('button', { name }));
    await screen.findByRole('button', { name: 'Save' });
    expect(reveals).toHaveLength(0);
  });
});
