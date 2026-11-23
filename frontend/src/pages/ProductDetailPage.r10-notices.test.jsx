// R10 Phase 3: every error and warning on the product detail page is the shared
// notice (base.css), not a page-local look. The danger notices are the stock-form
// validation and save-failure messages, and a failed reversal on a history entry;
// the warning is the over-removal dialog. Their ids, roles, text and behavior are
// pinned by ProductDetailPage.test.jsx, which passes unmodified; this pins only
// which classes carry them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

const PRODUCT = { id: 'p1', name: 'Parle-G', quantity: 10, lowStockThreshold: null, lowStockDisabled: false };
const HISTORY = [{ id: 'e1', type: 'ADD', quantity: 4, appliedQuantity: 4, comment: null, reversalOf: null, reversedBy: null, recordedAt: '2026-09-01T10:00:00.000Z' }];

function mount(stock = {}) {
  const productService = { listProducts: vi.fn(), getProduct: vi.fn().mockResolvedValue(PRODUCT), createProduct: vi.fn(), updateProduct: vi.fn() };
  const stockEventService = {
    getHistory: vi.fn().mockResolvedValue(HISTORY),
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
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

const refusal = { event: null, errors: ['Quantity must be greater than 0.'] };
const open = async (name) => fireEvent.click(await screen.findByRole('button', { name }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const setQuantity = (value) => fireEvent.change(screen.getByLabelText('Quantity'), { target: { value } });

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('stock-form errors are the shared danger notice', () => {
  // Mocks are built inside each test: restoreAllMocks in afterEach would otherwise
  // reset the ones for cases that have not run yet.
  it.each([
    ['Add Stock validation', 'Add Stock', () => ({ addStock: vi.fn().mockResolvedValue(refusal) }), '', 'add-form-errors'],
    ['Add Stock save failure', 'Add Stock', () => ({ addStock: vi.fn().mockRejectedValue(new Error('x')) }), '3', 'add-form-submit-error'],
    ['Remove Stock validation', 'Remove Stock', () => ({ removeStock: vi.fn().mockResolvedValue(refusal) }), '', 'remove-form-errors'],
    ['Remove Stock save failure', 'Remove Stock', () => ({ removeStock: vi.fn().mockRejectedValue(new Error('x')) }), '2', 'remove-form-submit-error']
  ])('%s', async (_label, toggle, makeStock, quantity, id) => {
    mount(makeStock());
    await open(toggle);
    if (quantity) setQuantity(quantity);
    save();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('id', id);
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('a failed reversal on a history entry', async () => {
    mount({ reverseEvent: vi.fn().mockResolvedValue({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));
    const row = (await screen.findAllByRole('listitem'))[0];
    expect(await within(row).findByRole('alert')).toHaveClass('notice', 'notice--danger');
  });
});

describe('the over-removal dialog is the shared warning notice', () => {
  it('keeps its dialog role and name, with notice--warning and no danger look', async () => {
    mount({ wouldOverRemove: vi.fn().mockResolvedValue(true), removeStock: vi.fn() });
    await open('Remove Stock');
    setQuantity('25');
    save();
    const dialog = await screen.findByRole('dialog', { name: 'Remove more than the available stock?' });
    expect(dialog).toHaveClass('notice', 'notice--warning', 'over-remove-warning');
    expect(dialog).not.toHaveClass('notice--danger');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Continue']);
  });
});
