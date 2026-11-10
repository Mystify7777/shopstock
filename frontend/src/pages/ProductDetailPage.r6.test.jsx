// Redesign R6: the Product Detail header, quantity hierarchy, rupee price, the
// stock-action bar and its text-entry behavior, the measured action-bar height
// and the history list. Stock semantics (add/remove, over-removal, undo,
// reversal, focus restoration) are pinned by ProductDetailPage.test.jsx, which
// passes unchanged apart from the wording of the quantity assertion. Real
// layout (stacking, clearance, the keyboard) is verified in a browser, not here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

const T1 = '2026-11-04T10:22:00.000Z';
const PRODUCT = { id: 'p1', name: 'Parle-G', quantity: 10, lowStockThreshold: null, lowStockDisabled: false };
const ev = (id, extra = {}) => ({
  id,
  type: 'ADD',
  quantity: 1,
  appliedQuantity: extra.quantity ?? 1,
  comment: null,
  reversalOf: null,
  reversedBy: null,
  recordedAt: T1,
  ...extra
});
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

function mount({ product = PRODUCT, history = [], stock = {} } = {}) {
  const productService = {
    listProducts: vi.fn(),
    getProduct: vi.fn().mockResolvedValue(product),
    createProduct: vi.fn(),
    updateProduct: vi.fn()
  };
  const stockEventService = {
    getHistory: vi.fn().mockResolvedValue(history),
    getLatestKnownCost: vi.fn().mockResolvedValue(null),
    wouldOverRemove: vi.fn().mockResolvedValue(false),
    addStock: vi.fn(),
    removeStock: vi.fn(),
    reverseEvent: vi.fn(),
    ...stock
  };
  return render(
    <AppProvider services={{ productService, stockEventService }}>
      <MemoryRouter initialEntries={['/products/p1']}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/products/:id/edit" element={<div>Edit product form</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}
const loaded = () => screen.findByRole('heading', { level: 1 });
const root = document.documentElement;

afterEach(() => {
  vi.restoreAllMocks();
  root.style.removeProperty('--stock-actions-height');
});

describe('header', () => {
  it('shows the full product name, however long, with no truncation class (it wraps)', async () => {
    const long = 'Extra Long Name Premium Imported Whole Grain Basmati Rice Family Pack 25 kg Value Edition';
    mount({ product: { ...PRODUCT, name: long } });
    const h1 = await loaded();
    expect(h1).toHaveTextContent(long);
    expect(h1.className).not.toMatch(/truncate/);
    expect(h1.closest('.product-detail__header')).not.toBeNull();
  });

  it('Edit is a plain link to the edit route inside the header, and it navigates', async () => {
    mount();
    const edit = await screen.findByRole('link', { name: 'Edit Product' });
    expect(edit).toHaveAttribute('href', '/products/p1/edit');
    expect(edit.closest('.product-detail__header')).not.toBeNull();
    expect(edit).toHaveClass('product-detail__edit');
    fireEvent.click(edit);
    expect(await screen.findByText('Edit product form')).toBeInTheDocument();
  });
});

describe('quantity and status', () => {
  it.each([
    [10, 'In stock', 'badge--ok'],
    [3, 'Low Stock', 'badge--low'],
    [0, 'Out of Stock', 'badge--out']
  ])('quantity %s shows the figure and the shared %s badge', async (quantity, text, modifier) => {
    mount({ product: { ...PRODUCT, quantity } });
    await loaded();
    const block = document.querySelector('.product-detail__quantity');
    expect(block.querySelector('.product-detail__quantity-figure')).toHaveTextContent(new RegExp(`^${quantity}$`));
    const badge = within(block).getByText(text);
    expect(badge).toHaveClass('badge', modifier);
    expect(badge.className.match(/badge--/g)).toHaveLength(1);
    expect(block).toHaveTextContent(`Quantity ${quantity} ${text}`);
    expect(document.querySelector('.stock-badge')).toBeNull(); // the old local badge is gone
  });

  it('the badge and the figure are plain text, not controls', async () => {
    mount({ product: { ...PRODUCT, quantity: 0 } });
    await loaded();
    expect(document.querySelector('.product-detail__quantity').querySelectorAll(INTERACTIVE)).toHaveLength(0);
  });

  it('shows no unit: the product only carries a unit id and the page does not resolve it', async () => {
    mount({ product: { ...PRODUCT, unitId: 'u1' } });
    await loaded();
    expect(document.querySelector('.product-detail__quantity')).toHaveTextContent(/^Quantity 10 In stock$/);
  });
});

describe('selling price', () => {
  it('shows ₹ in front of the formatted amount, and the sentence still reads "Selling price: 1,234.50"', async () => {
    mount({ product: { ...PRODUCT, sellingPrice: 1234.5 } });
    expect(await screen.findByText('Selling price: 1,234.50')).toBeInTheDocument();
    expect(document.querySelector('.product-detail__currency')).toHaveTextContent('₹');
    expect(document.body.textContent.match(/₹/g)).toHaveLength(1);
  });

  it('shows no ₹ at all when the product has no price', async () => {
    mount();
    await loaded();
    expect(document.body.textContent).not.toContain('₹');
    expect(screen.queryByText(/Selling price/)).not.toBeInTheDocument();
  });

  it('never describes the price as revenue, profit, sales or earnings', async () => {
    mount({ product: { ...PRODUCT, sellingPrice: 80 } });
    await loaded();
    expect(document.body.textContent).not.toMatch(/revenue|profit|sales|earning/i);
  });
});

describe('stock actions', () => {
  it('Add Stock is the primary action and Remove Stock is secondary, both in one bar, none nested', async () => {
    mount();
    await loaded();
    const bar = document.querySelector('.product-detail__actions');
    const add = within(bar).getByRole('button', { name: 'Add Stock' });
    const remove = within(bar).getByRole('button', { name: 'Remove Stock' });
    expect(add).toHaveClass('primary-action');
    expect(remove).not.toHaveClass('primary-action');
    expect(bar.querySelectorAll(INTERACTIVE)).toHaveLength(2);
    for (const button of [add, remove]) expect(button.querySelector(INTERACTIVE)).toBeNull();
  });

  it('still opens the existing inline forms, with aria-expanded, and adds no query parameter or route', async () => {
    mount();
    await loaded();
    const add = screen.getByRole('button', { name: 'Add Stock' });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByLabelText('Quantity')).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('keeps the bar in its place in the page structure, before the forms, so form order is unchanged', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Stock' }));
    const form = await screen.findByLabelText('Quantity');
    const bar = document.querySelector('.product-detail__actions');
    expect(bar.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('text entry leaves the fixed layer without removing the buttons', () => {
  const bar = () => document.querySelector('.product-detail__actions');

  it('marks the bar while a text field has focus and clears it when focus leaves', async () => {
    mount();
    await loaded();
    expect(bar()).not.toHaveAttribute('data-text-entry');
    fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
    const quantity = await screen.findByLabelText('Quantity');
    quantity.focus();
    await waitFor(() => expect(bar()).toHaveAttribute('data-text-entry', 'true'));
    quantity.blur();
    await waitFor(() => expect(bar()).not.toHaveAttribute('data-text-entry'));
  });

  it('stays marked while focus moves from one field to another (no flicker)', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
    const quantity = await screen.findByLabelText('Quantity');
    quantity.focus();
    await waitFor(() => expect(bar()).toHaveAttribute('data-text-entry', 'true'));
    // a real browser reports where focus is going on the focusout
    fireEvent.focusOut(quantity, { relatedTarget: screen.getByLabelText('Cost per unit') });
    expect(bar()).toHaveAttribute('data-text-entry', 'true');
  });

  it('does not stay marked when the focused field disappears with its form (no focusout is fired then)', async () => {
    mount();
    await loaded();
    const add = screen.getByRole('button', { name: 'Add Stock' });
    fireEvent.click(add);
    (await screen.findByLabelText('Quantity')).focus();
    await waitFor(() => expect(bar()).toHaveAttribute('data-text-entry', 'true'));
    fireEvent.click(add); // closes the form; the focused field is removed
    await waitFor(() => expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument());
    await waitFor(() => expect(bar()).not.toHaveAttribute('data-text-entry'));
  });

  it('clears when focus moves to a button, and the buttons are never removed or hidden', async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
    const quantity = await screen.findByLabelText('Quantity');
    quantity.focus();
    await waitFor(() => expect(bar()).toHaveAttribute('data-text-entry', 'true'));
    // while marked, both buttons are still rendered, visible to assistive tech and focusable
    for (const name of ['Add Stock', 'Remove Stock']) {
      const button = screen.getByRole('button', { name });
      expect(button).not.toBeDisabled();
      expect(bar()).not.toHaveAttribute('hidden');
      button.focus();
      expect(button).toHaveFocus();
    }
    await waitFor(() => expect(bar()).not.toHaveAttribute('data-text-entry'));
  });
});

describe('the action bar height is measured and published', () => {
  function withBarGeometry({ position, height }) {
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
      position: el.classList?.contains('product-detail__actions') ? position : 'static'
    }));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const h = this.classList?.contains('product-detail__actions') ? height : 0;
      return { top: 0, bottom: h, height: h, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} };
    });
  }

  it('publishes --stock-actions-height as the bar\'s own height while it is fixed', async () => {
    withBarGeometry({ position: 'fixed', height: 64 });
    mount();
    await loaded();
    await waitFor(() => expect(root.style.getPropertyValue('--stock-actions-height')).toBe('64px'));
  });

  it('publishes 0 while the bar is in the page flow (wide screens)', async () => {
    withBarGeometry({ position: 'static', height: 64 });
    mount();
    await loaded();
    await waitFor(() => expect(root.style.getPropertyValue('--stock-actions-height')).toBe('0px'));
  });

  it('keeps publishing the same height while a field has focus (bar absolute), so the reservation never changes', async () => {
    // jsdom has no stylesheet, so the position follows the attribute the page sets.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      if (!el.classList?.contains('product-detail__actions')) return style;
      const position = el.dataset.textEntry === 'true' ? 'absolute' : 'fixed';
      return new Proxy(style, {
        get: (target, key) => (key === 'position' ? position : typeof target[key] === 'function' ? target[key].bind(target) : target[key])
      });
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const h = this.classList?.contains('product-detail__actions') ? 64 : 0;
      return { top: 0, bottom: h, height: h, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} };
    });
    mount();
    await loaded();
    await waitFor(() => expect(root.style.getPropertyValue('--stock-actions-height')).toBe('64px'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
    (await screen.findByLabelText('Quantity')).focus();
    await waitFor(() => expect(document.querySelector('.product-detail__actions')).toHaveAttribute('data-text-entry', 'true'));
    expect(root.style.getPropertyValue('--stock-actions-height')).toBe('64px');
  });

  it('clears the value when the page goes away, so no clearance is left behind', async () => {
    withBarGeometry({ position: 'fixed', height: 64 });
    const view = mount();
    await loaded();
    await waitFor(() => expect(root.style.getPropertyValue('--stock-actions-height')).toBe('64px'));
    view.unmount();
    expect(root.style.getPropertyValue('--stock-actions-height')).toBe('');
  });
});

describe('history', () => {
  it('Stock History is its own section; there is no Product Change History on this page to merge it with', async () => {
    mount({ history: [ev('a', { quantity: 24, comment: 'New delivery' })] });
    await loaded();
    expect(await screen.findByRole('heading', { level: 2, name: 'Stock History' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /change history/i })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.history-list')).toHaveLength(1);
  });

  it('keeps each entry\'s sign, amount, kind, time and comment, and Reverse where it was before', async () => {
    mount({
      history: [
        ev('a', { quantity: 24, comment: 'New delivery' }),
        ev('r', { type: 'REMOVE', quantity: 16, appliedQuantity: 16, comment: 'Sold' })
      ]
    });
    await loaded();
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const amounts = rows.map((row) => row.querySelector('.history-entry__amount').textContent);
    expect(amounts.sort()).toEqual(['+24', '-16']);
    for (const row of rows) {
      expect(row.querySelector('.history-entry__time')).not.toBeNull();
      const reverse = within(row).getByRole('button', { name: 'Reverse this action' });
      expect(reverse).toHaveClass('quiet-action');
    }
    expect(within(rows.find((row) => row.textContent.includes('Sold'))).getByText('Sold')).toBeInTheDocument();
  });

  it('an entry that was already reversed offers no Reverse, exactly as before', async () => {
    mount({ history: [ev('a', { quantity: 5, reversedBy: 'x' })] });
    await loaded();
    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).queryByRole('button', { name: 'Reverse this action' })).not.toBeInTheDocument();
  });
});
