import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';
import { todayDateOnly } from '../domain/shared/dates.js';

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
          <Route path="/products" element={<div>Product list</div>} />
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
  it('shows Product not found with a working way back to Products when the product does not exist', async () => {
    const productService = makeMockProductService({
      getProduct: vi.fn().mockResolvedValue(null)
    });
    const stockEventService = makeMockStockEventService();
    renderDetail(productService, stockEventService, 'missing-id');

    // the alert keeps exactly the original message
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Product not found\.$/);
    fireEvent.click(screen.getByRole('link', { name: 'Back to Products' }));
    expect(screen.getByText('Product list')).toBeInTheDocument();
  });

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

  // ===========================================================================
  // Phase 7E -- redesign and hardening of the existing page
  // ===========================================================================
  describe('Phase 7E', () => {
    const T1 = '2026-09-01T10:00:00.000Z';
    const T2 = '2026-09-02T10:00:00.000Z';
    const T3 = '2026-09-03T10:00:00.000Z';

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

    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    function mount({ product = SAMPLE_PRODUCT, history = [], product2, stock = {}, id = 'p1' } = {}) {
      const productService = makeMockProductService({
        getProduct: vi.fn().mockResolvedValue(product),
        ...(product2 || {})
      });
      const stockEventService = makeMockStockEventService({
        getHistory: vi.fn().mockResolvedValue(history),
        ...stock
      });
      renderDetail(productService, stockEventService, id);
      return { productService, stockEventService };
    }

    const heading = () => screen.findByRole('heading', { level: 1 });
    const openAdd = async () => {
      await heading();
      fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
    };
    const openRemove = async () => {
      await heading();
      fireEvent.click(screen.getByRole('button', { name: 'Remove Stock' }));
    };
    const entries = () => screen.queryAllByRole('listitem');
    const entryAmounts = () => entries().map((li) => li.querySelector('.history-entry__amount')?.textContent);

    // -----------------------------------------------------------------------
    describe('product detail', () => {
      it('shows the name, the quantity as text, and a stock-status label', async () => {
        mount();
        expect(await screen.findByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        expect(screen.getByText(/Quantity: 10/)).toBeInTheDocument();
        expect(screen.getByText('In stock')).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: /./ })).not.toBeInTheDocument();
      });

      it.each([
        [3, 'Low Stock'],
        [0, 'Out of Stock']
      ])('labels quantity %s as %s using role="status"', async (quantity, label) => {
        mount({ product: { ...SAMPLE_PRODUCT, quantity } });
        await heading();
        const badge = screen.getByText(label);
        expect(badge).toHaveAttribute('role', 'status');
        expect(screen.queryByText('In stock')).not.toBeInTheDocument();
      });

      it('falls back to "Unnamed product" for a photo-only product', async () => {
        mount({ product: { ...SAMPLE_PRODUCT, name: null } });
        expect(await screen.findByRole('heading', { level: 1, name: 'Unnamed product' })).toBeInTheDocument();
      });

      it('shows the selling price only when the product has one', async () => {
        mount({ product: { ...SAMPLE_PRODUCT, sellingPrice: 1234.5 } });
        expect(await screen.findByText('Selling price: 1,234.50')).toBeInTheDocument();
      });

      it('shows no selling price line when none is set', async () => {
        mount({ product: { ...SAMPLE_PRODUCT, sellingPrice: null } });
        await heading();
        expect(screen.queryByText(/selling price/i)).not.toBeInTheDocument();
      });

      it('does not show cost, margin, internal ids, units or classification ids (deferred / not available)', async () => {
        mount({
          product: {
            ...SAMPLE_PRODUCT,
            sellingPrice: 100,
            unitId: 'unit-secret',
            categoryId: 'cat-secret',
            locationIds: ['loc-secret'],
            tagIds: ['tag-secret']
          },
          history: [ev('evt-secret', { costPerUnit: 55 })]
        });
        await heading();
        const text = document.body.textContent;
        for (const hidden of ['unit-secret', 'cat-secret', 'loc-secret', 'tag-secret', 'evt-secret']) {
          expect(text).not.toContain(hidden);
        }
        expect(text).not.toMatch(/margin|average|latest cost/i);
      });

      it('has an Edit Product link to the edit route that opens it', async () => {
        mount();
        const edit = await screen.findByRole('link', { name: 'Edit Product' });
        expect(edit).toHaveAttribute('href', '/products/p1/edit');
        fireEvent.click(edit);
        expect(await screen.findByText('Edit product form')).toBeInTheDocument();
      });

      it('has a persistent link back to Products that works', async () => {
        mount();
        const back = await screen.findByRole('link', { name: /Products/ });
        expect(back).toHaveAttribute('href', '/products');
        fireEvent.click(back);
        expect(await screen.findByText('Product list')).toBeInTheDocument();
      });
    });

    // -----------------------------------------------------------------------
    describe('loading, errors and retry', () => {
      it('keeps the back link visible and shows loading only in the content area', () => {
        mount({ product2: { getProduct: vi.fn(() => new Promise(() => {})) } });
        expect(screen.getByRole('link', { name: /Products/ })).toBeInTheDocument();
        expect(screen.getByText('Loading product…')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
      });

      it('on a product-load failure: friendly message, the detail, Try again, and the back link', async () => {
        mount({ product2: { getProduct: vi.fn().mockRejectedValue(new Error('disk read failed')) } });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("Couldn't load this product.");
        expect(screen.getByText('disk read failed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Products/ })).toBeInTheDocument();
      });

      it('Try again reloads the product and shows it', async () => {
        const getProduct = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce(SAMPLE_PRODUCT);
        mount({ product2: { getProduct } });
        fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(getProduct).toHaveBeenCalledTimes(2);
      });

      it('shows the not-found state for a missing product (null) with a way back', async () => {
        mount({ product2: { getProduct: vi.fn().mockResolvedValue(null) } });
        expect(await screen.findByText('Product not found.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Back to Products' })).toHaveAttribute('href', '/products');
      });

      it('shows a history loading state without hiding the product', async () => {
        mount({ stock: { getHistory: vi.fn(() => new Promise(() => {})) } });
        await heading();
        expect(screen.getByText('Loading history…')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add Stock' })).toBeInTheDocument();
      });

      it('a history failure leaves the product and stock controls usable, with detail and retry', async () => {
        const getHistory = vi.fn().mockRejectedValueOnce(new Error('history store down')).mockResolvedValueOnce([ev('e1', { quantity: 7, comment: 'Back again' })]);
        mount({ stock: { getHistory } });

        expect(await screen.findByText('history store down')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the stock history.");
        // product and controls unaffected
        expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
        expect(screen.getByLabelText('Quantity')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Back again')).toBeInTheDocument();
        expect(getHistory).toHaveBeenCalledTimes(2);
      });

      it('does not blank the page while the product reloads after a stock operation', async () => {
        const reload = deferred();
        const getProduct = vi.fn().mockResolvedValueOnce(SAMPLE_PRODUCT).mockReturnValueOnce(reload.promise);
        mount({
          product2: { getProduct },
          stock: { addStock: vi.fn().mockResolvedValue({ event: { id: 'n1', appliedQuantity: 2 }, errors: [] }) }
        });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Save'));

        expect(await screen.findByText(/Stock increased by 2/)).toBeInTheDocument();
        // the reload is still pending, yet the page content is intact
        expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        expect(screen.queryByText('Loading product…')).not.toBeInTheDocument();
        reload.resolve({ ...SAMPLE_PRODUCT, quantity: 12 });
        expect(await screen.findByText(/Quantity: 12/)).toBeInTheDocument();
      });
    });

    // -----------------------------------------------------------------------
    describe('Add Stock', () => {
      const costField = () => screen.getByLabelText('Cost per unit');

      it('prefills the latest known cost on the first open', async () => {
        mount({ stock: { getLatestKnownCost: vi.fn().mockResolvedValue(55) } });
        await openAdd();
        await waitFor(() => expect(costField()).toHaveValue(55));
      });

      it('leaves the cost field empty when there is no latest cost', async () => {
        const { stockEventService } = mount({ stock: { getLatestKnownCost: vi.fn().mockResolvedValue(null) } });
        await openAdd();
        await waitFor(() => expect(stockEventService.getLatestKnownCost).toHaveBeenCalledWith('p1'));
        await new Promise((r) => setTimeout(r, 20));
        expect(costField()).toHaveValue(null);
      });

      it('does not overwrite a cost the user already typed when the async result arrives', async () => {
        const late = deferred();
        mount({ stock: { getLatestKnownCost: vi.fn(() => late.promise) } });
        await openAdd();

        fireEvent.change(costField(), { target: { value: '99' } });
        late.resolve(55);
        await new Promise((r) => setTimeout(r, 20));

        expect(costField()).toHaveValue(99);
      });

      it('does not refill a cost the user deliberately cleared', async () => {
        const late = deferred();
        mount({ stock: { getLatestKnownCost: vi.fn(() => late.promise) } });
        await openAdd();

        fireEvent.change(costField(), { target: { value: '5' } });
        fireEvent.change(costField(), { target: { value: '' } });
        late.resolve(55);
        await new Promise((r) => setTimeout(r, 20));

        expect(costField()).toHaveValue(null);
      });

      it('keeps the form usable when the latest cost cannot be read', async () => {
        const { stockEventService } = mount({ stock: { getLatestKnownCost: vi.fn().mockRejectedValue(new Error('x')) } });
        await openAdd();
        await waitFor(() => expect(stockEventService.getLatestKnownCost).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(costField()).toHaveValue(null);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
        expect(screen.getByLabelText('Quantity')).toHaveValue(3);
      });

      it("ignores a previous open's prefill that resolves after the form was closed and reopened", async () => {
        const first = deferred();
        const second = deferred();
        const getLatestKnownCost = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        mount({ stock: { getLatestKnownCost } });
        await openAdd();
        fireEvent.click(screen.getByRole('button', { name: 'Add Stock' })); // close
        fireEvent.click(screen.getByRole('button', { name: 'Add Stock' })); // reopen
        expect(getLatestKnownCost).toHaveBeenCalledTimes(2);

        first.resolve(55); // the FIRST open's answer arrives late
        await new Promise((r) => setTimeout(r, 20));
        expect(costField()).toHaveValue(null); // must not leak into the second open

        second.resolve(60); // the current open's own answer still applies
        await waitFor(() => expect(costField()).toHaveValue(60));
      });

      it("prefills today's purchase date", async () => {
        mount();
        await openAdd();
        expect(screen.getByLabelText('Purchase date')).toHaveValue(todayDateOnly());
      });

      it('sends exactly the entered values to the existing service', async () => {
        const { stockEventService } = mount({
          stock: { addStock: vi.fn().mockResolvedValue({ event: { id: 'n1', appliedQuantity: 20 }, errors: [] }) }
        });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText('Cost per unit'), { target: { value: '55' } });
        fireEvent.change(screen.getByLabelText('Purchase date'), { target: { value: '2026-08-08' } });
        fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'New delivery' } });
        fireEvent.click(screen.getByText('Save'));

        await waitFor(() =>
          expect(stockEventService.addStock).toHaveBeenCalledWith({
            productId: 'p1',
            quantity: 20,
            costPerUnit: 55,
            purchaseDate: '2026-08-08',
            comment: 'New delivery'
          })
        );
      });

      it('accepts decimal quantities (step="any") with native validation left on, and leaves domain validation to the service', async () => {
        const { stockEventService } = mount({
          stock: { addStock: vi.fn().mockResolvedValue({ event: { id: 'n1', appliedQuantity: 2.5 }, errors: [] }) }
        });
        await openAdd();
        const quantity = screen.getByLabelText('Quantity');
        expect(quantity).toHaveAttribute('step', 'any');
        // native browser validation stays enabled on the form
        expect(quantity.closest('form')).not.toHaveAttribute('novalidate');

        fireEvent.change(quantity, { target: { value: '2.5' } });
        // a decimal is natively valid, so it is not blocked before reaching the service
        expect(quantity.validity.valid).toBe(true);
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(stockEventService.addStock).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2.5 })));
      });

      it('does not block values the service must judge (empty, zero, negative): native validation lets them through', async () => {
        const addStock = vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] });
        mount({ stock: { addStock } });
        await openAdd();
        const quantity = screen.getByLabelText('Quantity');
        for (const value of ['', '0', '-3']) {
          fireEvent.change(quantity, { target: { value } });
          expect(quantity.validity.valid).toBe(true);
        }
        // submitting an empty quantity reaches the service, whose message is what the user sees
        fireEvent.change(quantity, { target: { value: '' } });
        fireEvent.click(screen.getByText('Save'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Quantity must be greater than 0.');
        expect(addStock).toHaveBeenCalledTimes(1);
      });

      it('on success: closes the form, reloads the product and history, and shows the undo notice', async () => {
        const { productService, stockEventService } = mount({
          stock: { addStock: vi.fn().mockResolvedValue({ event: { id: 'n1', appliedQuantity: 4 }, errors: [] }) }
        });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '4' } });
        fireEvent.click(screen.getByText('Save'));

        expect(await screen.findByText('Stock increased by 4')).toBeInTheDocument();
        expect(screen.queryByLabelText('Cost per unit')).not.toBeInTheDocument();
        await waitFor(() => {
          expect(productService.getProduct).toHaveBeenCalledTimes(2);
          expect(stockEventService.getHistory).toHaveBeenCalledTimes(2);
        });
      });

      describe('validation errors stay form-level and are tied to the inputs', () => {
        it('shows the service messages and links the inputs to them with aria-describedby', async () => {
          mount({
            stock: {
              addStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.', 'Cost must be 0 or more.'] })
            }
          });
          await openAdd();
          expect(screen.getByLabelText('Quantity')).not.toHaveAttribute('aria-describedby');
          fireEvent.click(screen.getByText('Save'));

          const list = await screen.findByRole('alert');
          expect(list).toHaveTextContent('Quantity must be greater than 0.');
          expect(list).toHaveTextContent('Cost must be 0 or more.');
          for (const label of ['Quantity', 'Cost per unit', 'Purchase date']) {
            expect(screen.getByLabelText(label)).toHaveAttribute('aria-describedby', list.id);
          }
          // the page is intact and stays on the product
          expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        });

        it('clears the errors (and the association) on the next submit attempt', async () => {
          const addStock = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors: ['Quantity must be greater than 0.'] })
            .mockResolvedValueOnce({ event: { id: 'n1', appliedQuantity: 1 }, errors: [] });
          mount({ stock: { addStock } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          await screen.findByRole('alert');
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
          fireEvent.click(screen.getByText('Save'));
          expect(await screen.findByText('Stock increased by 1')).toBeInTheDocument();
        });
      });

      it('on an unexpected failure: keeps the page and the entered values, shows the error, and can retry', async () => {
        const addStock = vi
          .fn()
          .mockRejectedValueOnce(new Error('write failed'))
          .mockResolvedValueOnce({ event: { id: 'n1', appliedQuantity: 6 }, errors: [] });
        mount({ stock: { addStock } });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '6' } });
        fireEvent.click(screen.getByText('Save'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('write failed');
        expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-describedby', alert.id);
        expect(screen.getByLabelText('Quantity')).toHaveValue(6);
        expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();

        fireEvent.click(screen.getByText('Save'));
        expect(await screen.findByText('Stock increased by 6')).toBeInTheDocument();
      });

      it('opening Remove Stock closes the Add form (one form at a time)', async () => {
        mount();
        await openAdd();
        fireEvent.click(screen.getByRole('button', { name: 'Remove Stock' }));
        expect(screen.queryByLabelText('Cost per unit')).not.toBeInTheDocument();
        expect(screen.getAllByLabelText('Quantity')).toHaveLength(1);
      });

      it('marks which form is open with aria-expanded', async () => {
        mount();
        await heading();
        const add = screen.getByRole('button', { name: 'Add Stock' });
        expect(add).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(add);
        expect(add).toHaveAttribute('aria-expanded', 'true');
      });
    });

    // -----------------------------------------------------------------------
    describe('Remove Stock', () => {
      it('sends the entered values and shows the undo notice on success', async () => {
        const { stockEventService } = mount({
          stock: { removeStock: vi.fn().mockResolvedValue({ event: { id: 'r1', appliedQuantity: 3 }, errors: [] }) }
        });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Sold' } });
        fireEvent.click(screen.getByText('Save'));

        await waitFor(() =>
          expect(stockEventService.removeStock).toHaveBeenCalledWith({ productId: 'p1', quantity: 3, comment: 'Sold' })
        );
        expect(await screen.findByText('Stock reduced by 3')).toBeInTheDocument();
      });

      it('warns before removing more than is available, and Cancel changes nothing', async () => {
        const { stockEventService } = mount({ stock: { wouldOverRemove: vi.fn().mockResolvedValue(true) } });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '25' } });
        fireEvent.click(screen.getByText('Save'));

        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Only 10 units are currently available. Remove 25 anyway?');
        fireEvent.click(screen.getByText('Cancel'));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(stockEventService.removeStock).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Quantity')).toHaveValue(25);
      });

      it('Continue commits the over-removal through the service', async () => {
        const { stockEventService } = mount({
          stock: {
            wouldOverRemove: vi.fn().mockResolvedValue(true),
            removeStock: vi.fn().mockResolvedValue({ event: { id: 'r1', appliedQuantity: 10 }, errors: [] })
          }
        });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '25' } });
        fireEvent.click(screen.getByText('Save'));
        fireEvent.click(await screen.findByText('Continue'));
        await waitFor(() => expect(stockEventService.removeStock).toHaveBeenCalledWith(expect.objectContaining({ quantity: 25 })));
        expect(await screen.findByText('Stock reduced by 10')).toBeInTheDocument();
      });

      it('shows form-level validation errors tied to the quantity input', async () => {
        mount({
          stock: { removeStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] }) }
        });
        await openRemove();
        fireEvent.click(screen.getByText('Save'));
        const list = await screen.findByRole('alert');
        expect(list).toHaveTextContent('Quantity must be greater than 0.');
        expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-describedby', list.id);
      });

      it('reports a failure of the over-removal check without losing the page', async () => {
        mount({ stock: { wouldOverRemove: vi.fn().mockRejectedValue(new Error('check failed')) } });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Save'));
        expect(await screen.findByRole('alert')).toHaveTextContent('check failed');
        expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
      });
    });

    // -----------------------------------------------------------------------
    describe('undo notice (page-local)', () => {
      const addOne = (extra = {}) => ({
        addStock: vi.fn().mockResolvedValue({ event: { id: 'new-event', appliedQuantity: 5 }, errors: [] }),
        ...extra
      });

      async function addAndGetNotice(stock) {
        const ctx = mount({ stock });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
        fireEvent.click(screen.getByText('Save'));
        await screen.findByText('Stock increased by 5');
        return ctx;
      }

      it('is announced through a persistent polite live region', async () => {
        mount({ stock: addOne() });
        await heading();
        const region = document.querySelector('.undo-slot');
        expect(region).toHaveAttribute('role', 'status');
        expect(region).toHaveAttribute('aria-live', 'polite');
        expect(region).toBeEmptyDOMElement(); // present before any notice exists

        fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
        fireEvent.click(screen.getByText('Save'));
        await screen.findByText('Stock increased by 5');
        expect(document.querySelector('.undo-slot')).toBe(region); // same region, now with content
        expect(region).toHaveTextContent('Stock increased by 5');
      });

      it('offers Undo and Dismiss', async () => {
        await addAndGetNotice(addOne());
        expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
      });

      it('Undo is a real reversal: calls reverseEvent with the new event id, closes the notice, and reloads', async () => {
        const { productService, stockEventService } = await addAndGetNotice(
          addOne({ reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) })
        );
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

        await waitFor(() => expect(stockEventService.reverseEvent).toHaveBeenCalledWith('new-event'));
        await waitFor(() => expect(screen.queryByText('Stock increased by 5')).not.toBeInTheDocument());
        await waitFor(() => {
          expect(productService.getProduct.mock.calls.length).toBeGreaterThanOrEqual(3);
          expect(stockEventService.getHistory.mock.calls.length).toBeGreaterThanOrEqual(3);
        });
      });

      it('Dismiss only hides the notice: it does NOT reverse anything', async () => {
        const { stockEventService } = await addAndGetNotice(addOne());
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText('Stock increased by 5')).not.toBeInTheDocument();
        expect(stockEventService.reverseEvent).not.toHaveBeenCalled();
      });

      it('disappears after about five seconds without reversing, and cleans up its timer', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          const { stockEventService } = await addAndGetNotice(addOne());
          expect(screen.getByText('Stock increased by 5')).toBeInTheDocument();

          await vi.advanceTimersByTimeAsync(4900);
          expect(screen.getByText('Stock increased by 5')).toBeInTheDocument();
          await vi.advanceTimersByTimeAsync(200);
          expect(screen.queryByText('Stock increased by 5')).not.toBeInTheDocument();
          expect(stockEventService.reverseEvent).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it('a failed Undo keeps the notice and reports the service reason on the history entry', async () => {
        await addAndGetNotice(
          addOne({
            getHistory: vi.fn().mockResolvedValue([ev('new-event', { quantity: 5, recordedAt: T1 })]),
            reverseEvent: vi.fn().mockResolvedValue({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] })
          })
        );
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await screen.findByText('Cannot reverse: current stock is insufficient.')).toBeInTheDocument();
        expect(screen.getByText('Stock increased by 5')).toBeInTheDocument();
      });
    });

    // -----------------------------------------------------------------------
    describe('stock history', () => {
      it('shows an empty message when there is no history', async () => {
        mount({ history: [] });
        expect(await screen.findByText('No stock history yet.')).toBeInTheDocument();
      });

      it('shows newest first', async () => {
        mount({
          history: [
            ev('a', { quantity: 1, recordedAt: T1 }),
            ev('b', { quantity: 2, recordedAt: T2 }),
            ev('c', { quantity: 3, recordedAt: T3 })
          ]
        });
        await screen.findAllByRole('listitem');
        expect(entryAmounts()).toEqual(['+3', '+2', '+1']);
      });

      it('keeps the service order for events with the same timestamp', async () => {
        mount({
          history: [
            ev('z', { quantity: 1, recordedAt: T1 }),
            ev('m', { quantity: 2, recordedAt: T1 }),
            ev('q', { quantity: 3, recordedAt: T2 })
          ]
        });
        await screen.findAllByRole('listitem');
        // newest (T2) first; the two T1 events stay in service order
        expect(entryAmounts()).toEqual(['+3', '+1', '+2']);
      });

      it('shows type, amount, time, purchase date, cost and comment from the real event fields', async () => {
        mount({
          history: [
            ev('a', {
              quantity: 20,
              recordedAt: '2026-08-09T09:42:00.000Z',
              purchaseDate: '2026-08-08',
              costPerUnit: 55,
              comment: 'New delivery'
            })
          ]
        });
        const row = (await screen.findAllByRole('listitem'))[0];
        expect(row).toHaveTextContent('+20');
        expect(row).toHaveTextContent('Added');
        expect(row).toHaveTextContent('New delivery');
        expect(row).toHaveTextContent('Purchased 08 Aug 2026.');
        expect(row).toHaveTextContent('Cost per unit: 55.');
        expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-08-09T09:42:00.000Z');
      });

      it('says "No cost recorded" for an addition without a cost, and "No justification provided" without a comment', async () => {
        mount({ history: [ev('a', { quantity: 5, costPerUnit: null, comment: null })] });
        const row = (await screen.findAllByRole('listitem'))[0];
        expect(row).toHaveTextContent('No cost recorded.');
        expect(row).toHaveTextContent('No justification provided');
      });

      it('shows a removal with a minus sign and no purchase/cost line', async () => {
        mount({ history: [ev('r', { type: 'REMOVE', quantity: 3, comment: 'Sold' })] });
        const row = (await screen.findAllByRole('listitem'))[0];
        expect(row).toHaveTextContent('-3');
        expect(row).toHaveTextContent('Removed');
        expect(row).not.toHaveTextContent(/cost|purchased/i);
      });

      it('shows a clamped over-removal by what actually applied, and says so', async () => {
        mount({ history: [ev('r', { type: 'REMOVE', quantity: 8, appliedQuantity: 5 })] });
        const row = (await screen.findAllByRole('listitem'))[0];
        expect(row).toHaveTextContent('-5');
        expect(row).toHaveTextContent('8 requested, but only 5 were available.');
      });

      it('does not crash on a malformed timestamp and simply omits the time', async () => {
        mount({ history: [ev('a', { recordedAt: 'garbage', purchaseDate: '2026-02-31', comment: 'Odd data' })] });
        const row = (await screen.findAllByRole('listitem'))[0];
        expect(row).toHaveTextContent('Odd data');
        expect(row.querySelector('time')).toBeNull();
      });

      describe('reversal status and eligibility', () => {
        it('labels a reversed original "Reversed" with NO Reverse control, and a reversal "Reversal" with one', async () => {
          mount({
            history: [
              ev('orig', { quantity: 5, reversedBy: 'rev', recordedAt: T1 }),
              ev('rev', { type: 'REMOVE', quantity: 5, reversalOf: 'orig', reversedBy: null, recordedAt: T2 })
            ]
          });
          await screen.findAllByRole('listitem');
          const [reversalRow, originalRow] = entries();
          expect(within(reversalRow).getByText('Reversal')).toBeInTheDocument();
          expect(within(reversalRow).getByRole('button', { name: 'Reverse this action' })).toBeInTheDocument();
          expect(within(originalRow).getByText('Reversed')).toBeInTheDocument();
          expect(within(originalRow).queryByRole('button', { name: 'Reverse this action' })).not.toBeInTheDocument();
        });

        it('only exposes reversal where the domain allows it', async () => {
          mount({
            history: [
              ev('a', { reversedBy: 'x', recordedAt: T1 }),
              ev('b', { recordedAt: T2 }),
              ev('c', { type: 'REMOVE', reversedBy: 'y', recordedAt: T3 })
            ]
          });
          await screen.findAllByRole('listitem');
          expect(screen.getAllByRole('button', { name: 'Reverse this action' })).toHaveLength(1);
        });

        it('reverses from history through the service, then reloads product and history', async () => {
          const { productService, stockEventService } = mount({
            history: [ev('b', { quantity: 4 })],
            stock: { reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) }
          });
          fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));

          await waitFor(() => expect(stockEventService.reverseEvent).toHaveBeenCalledWith('b'));
          await waitFor(() => {
            expect(productService.getProduct).toHaveBeenCalledTimes(2);
            expect(stockEventService.getHistory).toHaveBeenCalledTimes(2);
          });
        });

        it('shows the service refusal on that entry and keeps the history unchanged', async () => {
          const { productService } = mount({
            history: [ev('b', { quantity: 4, comment: 'Keep me' })],
            stock: {
              reverseEvent: vi.fn().mockResolvedValue({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] })
            }
          });
          fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));

          const row = (await screen.findAllByRole('listitem'))[0];
          expect(await within(row).findByRole('alert')).toHaveTextContent('Cannot reverse: current stock is insufficient.');
          expect(row).toHaveTextContent('Keep me');
          expect(productService.getProduct).toHaveBeenCalledTimes(1); // nothing reloaded, nothing changed
        });

        it('reports an unexpected reversal failure without losing the page', async () => {
          mount({
            history: [ev('b')],
            stock: { reverseEvent: vi.fn().mockRejectedValue(new Error('reversal exploded')) }
          });
          fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));
          expect(await screen.findByText('reversal exploded')).toBeInTheDocument();
          expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
        });

        it('disables the Reverse controls while a reversal is in progress', async () => {
          const pending = deferred();
          mount({
            history: [ev('a', { recordedAt: T1 }), ev('b', { recordedAt: T2 })],
            stock: { reverseEvent: vi.fn(() => pending.promise) }
          });
          const buttons = await screen.findAllByRole('button', { name: 'Reverse this action' });
          fireEvent.click(buttons[0]);
          await waitFor(() => {
            for (const b of screen.getAllByRole('button', { name: 'Reverse this action' })) expect(b).toBeDisabled();
          });
          pending.resolve({ event: { id: 'rev' }, errors: [] });
          await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reverse this action' })[0]).toBeEnabled());
        });
      });
    });
  });
});
