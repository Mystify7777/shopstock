import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

// productService and stockEventService are mocked here at the AppContext
// boundary -- the real service -> repository -> Dexie path is covered by
// productService.test.js and stockEventService.test.js, not here.

function makeMockProductService(overrides = {}) {
  return {
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    ...overrides
  };
}

function makeMockStockEventService(overrides = {}) {
  return {
    getHistory: vi.fn().mockResolvedValue([]),
    getLatestKnownCost: vi.fn().mockResolvedValue(null),
    wouldOverRemove: vi.fn().mockResolvedValue(false),
    addStock: vi.fn(),
    removeStock: vi.fn(),
    reverseEvent: vi.fn(),
    ...overrides
  };
}

function renderDetail(productService, stockEventService, id = 'p1') {
  return render(
    <AppProvider services={{ productService, stockEventService }}>
      <MemoryRouter initialEntries={[`/products/${id}`]}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/products/:id/edit" element={<div>Edit product form</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

const SAMPLE_PRODUCT = {
  id: 'p1',
  name: 'Parle-G',
  quantity: 10,
  lowStockThreshold: null,
  lowStockDisabled: false
};

describe('ProductDetailPage', () => {
  it('shows a loading state before product resolves', () => {
    const productService = makeMockProductService({
      getProduct: vi.fn(() => new Promise(() => {}))
    });
    const stockEventService = makeMockStockEventService();
    renderDetail(productService, stockEventService);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders product name and quantity once loaded', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService();
    renderDetail(productService, stockEventService);

    await waitFor(() => {
      expect(screen.getByText('Parle-G')).toBeInTheDocument();
      expect(screen.getByText(/Quantity: 10/)).toBeInTheDocument();
    });
  });

  it('shows a product-load error state distinct from history errors', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockRejectedValue(new Error('product load failed'))
    });
    const stockEventService = makeMockStockEventService();
    renderDetail(productService, stockEventService);

    await waitFor(() => {
      expect(screen.getByText('product load failed')).toBeInTheDocument();
    });
  });

  it('shows a history-load error independently of a successful product load', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      getHistory: vi.fn().mockRejectedValue(new Error('history load failed'))
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => {
      expect(screen.getByText('Parle-G')).toBeInTheDocument(); // product still rendered
      expect(screen.getByText('history load failed')).toBeInTheDocument();
    });
  });

  it('renders stock history entries with comment fallback text', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      getHistory: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'ADD', quantity: 20, comment: 'New delivery', reversedBy: null },
        { id: 'e2', type: 'REMOVE', quantity: 3, comment: null, reversedBy: null }
      ])
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => {
      expect(screen.getByText(/New delivery/)).toBeInTheDocument();
      expect(screen.getByText(/No justification provided/)).toBeInTheDocument();
    });
  });

  it('does not render a Reverse control for an already-reversed entry', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      getHistory: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'ADD', quantity: 20, comment: null, reversedBy: 'e2' }
      ])
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText(/No justification provided/));
    expect(screen.queryByText('Reverse this action')).not.toBeInTheDocument();
  });

  it('navigates to /products/:id/edit when Edit Product is clicked', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService();
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Edit Product'));

    await waitFor(() => {
      expect(screen.getByText('Edit product form')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Add Stock
  // ===========================================================================

  it('Add Stock form submits with entered fields and shows the undo toast', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      addStock: vi.fn().mockResolvedValue({
        event: { id: 'new-event', appliedQuantity: 20 },
        errors: []
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Add Stock'));

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(stockEventService.addStock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p1', quantity: 20 })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Stock increased by 20/)).toBeInTheDocument();
    });
  });

  it('Add Stock renders validation errors without navigating away', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      addStock: vi.fn().mockResolvedValue({
        event: null,
        errors: ['Quantity must be greater than 0.']
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Add Stock'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Quantity must be greater than 0.')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Remove Stock -- over-removal warning
  // ===========================================================================

  it('Remove Stock with sufficient stock does not show the warning and calls removeStock directly', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      wouldOverRemove: vi.fn().mockResolvedValue(false),
      removeStock: vi.fn().mockResolvedValue({
        event: { id: 'e-remove', appliedQuantity: 3 },
        errors: []
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Remove Stock'));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(stockEventService.removeStock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p1', quantity: 3 })
      );
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Remove Stock over-removal shows Cancel/Continue and does NOT call removeStock until Continue', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      wouldOverRemove: vi.fn().mockResolvedValue(true),
      removeStock: vi.fn().mockResolvedValue({
        event: { id: 'e-remove', appliedQuantity: 10 },
        errors: []
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Remove Stock'));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
    expect(stockEventService.removeStock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Continue'));

    await waitFor(() => {
      expect(stockEventService.removeStock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p1', quantity: 15 })
      );
    });
  });

  it('Remove Stock over-removal Cancel does not call removeStock', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      wouldOverRemove: vi.fn().mockResolvedValue(true),
      removeStock: vi.fn()
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Remove Stock'));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(stockEventService.removeStock).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Undo + Reverse
  // ===========================================================================

  it('Undo button calls reverseEvent with the just-committed event id', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      addStock: vi.fn().mockResolvedValue({
        event: { id: 'just-added', appliedQuantity: 20 },
        errors: []
      }),
      reverseEvent: vi.fn().mockResolvedValue({
        event: { id: 'reversal-1' },
        errors: []
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Add Stock'));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => screen.getByText('Undo'));
    fireEvent.click(screen.getByText('Undo'));

    await waitFor(() => {
      expect(stockEventService.reverseEvent).toHaveBeenCalledWith('just-added');
    });
  });

  it('"Reverse this action" on a history entry calls reverseEvent with that entry id', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      getHistory: vi.fn().mockResolvedValue([
        { id: 'hist-1', type: 'ADD', quantity: 20, comment: null, reversedBy: null }
      ]),
      reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'reversal-2' }, errors: [] })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Reverse this action'));
    fireEvent.click(screen.getByText('Reverse this action'));

    await waitFor(() => {
      expect(stockEventService.reverseEvent).toHaveBeenCalledWith('hist-1');
    });
  });

  it('renders the reversal-blocked error message inline when reverseEvent returns errors', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      getHistory: vi.fn().mockResolvedValue([
        { id: 'hist-1', type: 'ADD', quantity: 10, comment: null, reversedBy: null }
      ]),
      reverseEvent: vi.fn().mockResolvedValue({
        event: null,
        errors: ['Cannot reverse: current stock is insufficient to fully restore this event\'s effect. Reversal was not applied.']
      })
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Reverse this action'));
    fireEvent.click(screen.getByText('Reverse this action'));

    await waitFor(() => {
      expect(screen.getByText(/Cannot reverse: current stock is insufficient/)).toBeInTheDocument();
    });
  });

  it('a wouldOverRemove ProductNotFoundError throw surfaces as an inline error, not a silent proceed', async () => {
    class ProductNotFoundError extends Error {}
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT)
    });
    const stockEventService = makeMockStockEventService({
      wouldOverRemove: vi.fn().mockRejectedValue(new ProductNotFoundError('Product not found: p1')),
      removeStock: vi.fn()
    });
    renderDetail(productService, stockEventService);

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText('Remove Stock'));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Product not found: p1')).toBeInTheDocument();
    });
    expect(stockEventService.removeStock).not.toHaveBeenCalled();
  });
});
