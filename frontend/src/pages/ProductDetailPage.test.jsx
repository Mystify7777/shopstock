import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetailPage from './ProductDetailPage.jsx';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';
import { AppProvider } from '../contexts/AppContext.jsx';
import { todayDateOnly } from '../domain/shared/dates.js';
import { createAddStockEvent, createRemoveStockEvent } from '../domain/stock/stockEventFactory.js';

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

  // 7H D5: the not-found page had no page-level heading (axe page-has-heading-one).
  it('the missing-product page has exactly one h1 that names the page, without repeating the alert text', async () => {
    renderDetail(makeMockProductService({ getProduct: vi.fn().mockResolvedValue(null) }), makeMockStockEventService(), 'missing-id');
    const alert = await screen.findByRole('alert');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Product');
    expect(headings[0]).not.toHaveTextContent('not found'); // the alert states the problem; the heading names the page
    expect(alert).toHaveTextContent(/^Product not found\.$/); // the alert text is unchanged
    expect(alert).not.toContainElement(headings[0]); // the heading is not announced as part of the alert
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
      expect(screen.queryByText('product load failed')).not.toBeInTheDocument();
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
      expect(screen.queryByText('history load failed')).not.toBeInTheDocument();
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

  // Phase 7I Slice A: the stock forms' Save buttons are primary actions.
  it.each(['Add Stock', 'Remove Stock'])('%s form Save button uses the shared primary-action class', async (opener) => {
    const productService = makeMockProductService({ getProduct: vi.fn().mockResolvedValue(SAMPLE_PRODUCT) });
    renderDetail(productService, makeMockStockEventService());

    await waitFor(() => screen.getByText('Parle-G'));
    fireEvent.click(screen.getByText(opener));

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('type', 'submit');
    expect(save).toHaveClass('primary-action');
  });

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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
      expect(screen.getByRole('dialog')).toBeInTheDocument();
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

    await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
    const consoleError = captureConsoleError('Checking available stock failed.');
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

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't check the available stock. Please try again.");
    expect(screen.queryByText('Product not found: p1')).not.toBeInTheDocument();
    expect(stockEventService.removeStock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'Checking available stock failed.',
      expect.objectContaining({ message: 'Product not found: p1' })
    );
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
      ])('labels quantity %s as %s as plain text, not a live region', async (quantity, label) => {
        mount({ product: { ...SAMPLE_PRODUCT, quantity } });
        await heading();
        const badge = screen.getByText(label);
        expect(badge).not.toHaveAttribute('role');
        expect(badge.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
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

      it('on a product-load failure: friendly message (no raw error text), Try again, and the back link', async () => {
        mount({ product2: { getProduct: vi.fn().mockRejectedValue(new Error('disk read failed')) } });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("Couldn't load this product.");
        expect(screen.queryByText('disk read failed')).not.toBeInTheDocument();
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

      it('a history failure leaves the product and stock controls usable, with a friendly message and retry', async () => {
        const getHistory = vi.fn().mockRejectedValueOnce(new Error('history store down')).mockResolvedValueOnce([ev('e1', { quantity: 7, comment: 'Back again' })]);
        mount({ stock: { getHistory } });

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the stock history.");
        expect(screen.queryByText('history store down')).not.toBeInTheDocument();
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

      // Phase 7H Slice 3. The messages are produced by the REAL domain factories
      // (not typed in by hand), so if their wording ever stops matching what the
      // page uses to find the field, these fail instead of silently dropping
      // aria-invalid.
      describe('field-error association (aria-invalid on the field a message is about)', () => {
        const realAddErrors = (input) => createAddStockEvent({ productId: 'p1', ...input }).errors;
        const realRemoveErrors = (input) => createRemoveStockEvent({ productId: 'p1', ...input }).errors;
        const msg = (errors, start) => errors.find((m) => m.startsWith(start));
        // Which of the three Add fields have an aria-describedby at all.
        const describedLabels = () =>
          ['Quantity', 'Cost per unit', 'Purchase date', 'Comment'].filter((label) =>
            screen.getByLabelText(label).hasAttribute('aria-describedby')
          );
        const invalidState = () =>
          Object.fromEntries(
            ['Quantity', 'Cost per unit', 'Purchase date', 'Comment'].map((label) => [
              label,
              screen.getByLabelText(label).getAttribute('aria-invalid')
            ])
          );

        // 7H D3: a <ul role="alert"> replaced the list's own role (axe listitem, aria-allowed-role).
        // The announcement is kept on a container, and the list inside keeps its list semantics.
        it('announces errors with a div alert that CONTAINS a real list, not a list that is itself an alert', async () => {
          const errors = realAddErrors({ quantity: 0, costPerUnit: -1 });
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors }) } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));

          const alert = await screen.findByRole('alert');
          expect(alert.tagName).toBe('DIV');
          expect(alert).toHaveAttribute('id', 'add-form-errors');
          const list = within(alert).getByRole('list'); // still exposed as a list
          expect(list.tagName).toBe('UL');
          expect(list).not.toHaveAttribute('role');
          expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(errors);
          expect(document.querySelectorAll('ul[role], ol[role]')).toHaveLength(0);
          expect(screen.getAllByRole('alert')).toHaveLength(1); // announced once
        });

        it('the remove form announces the same way', async () => {
          mount({ stock: { removeStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] }) } });
          await openRemove();
          fireEvent.click(screen.getByText('Save'));
          const alert = await screen.findByRole('alert');
          expect(alert.tagName).toBe('DIV');
          expect(alert).toHaveAttribute('id', 'remove-form-errors');
          expect(within(alert).getAllByRole('listitem')).toHaveLength(1);
          expect(document.querySelectorAll('ul[role], ol[role]')).toHaveLength(0);
        });

        it('flags exactly the fields the real messages are about, and describes each by its OWN message only', async () => {
          const errors = realAddErrors({ quantity: 0, costPerUnit: -1, purchaseDate: '2026-02-31' });
          expect(errors).toHaveLength(3); // quantity, cost and date -- if this changes, revisit the matching
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors }) } });
          await openAdd();
          expect(invalidState()).toEqual({ Quantity: null, 'Cost per unit': null, 'Purchase date': null, Comment: null });
          fireEvent.click(screen.getByText('Save'));

          const list = await screen.findByRole('alert');
          expect(invalidState()).toEqual({ Quantity: 'true', 'Cost per unit': 'true', 'Purchase date': 'true', Comment: null });

          for (const [label, start] of [['Quantity', 'Quantity'], ['Cost per unit', 'Cost per unit'], ['Purchase date', 'Purchase date']]) {
            const field = screen.getByLabelText(label);
            expect(field).toHaveAccessibleDescription(msg(errors, start)); // its message, nothing else
            // the description points at a list item inside the form's alert
            const item = document.getElementById(field.getAttribute('aria-describedby'));
            expect(list).toContainElement(item);
            expect(item).toHaveTextContent(msg(errors, start));
          }
          expect(screen.getByLabelText('Quantity')).not.toHaveAccessibleDescription(expect.stringContaining('Cost per unit'));
          expect(describedLabels()).toEqual(['Quantity', 'Cost per unit', 'Purchase date']); // not Comment
          expect(list).toHaveAttribute('id', 'add-form-errors'); // the alert itself is unchanged
        });

        it.each([
          ['quantity', { quantity: 0 }, { Quantity: 'true', 'Cost per unit': null, 'Purchase date': null }],
          ['cost', { quantity: 1, costPerUnit: -5 }, { Quantity: null, 'Cost per unit': 'true', 'Purchase date': null }],
          ['purchase date', { quantity: 1, purchaseDate: '2026-02-31' }, { Quantity: null, 'Cost per unit': null, 'Purchase date': 'true' }]
        ])('flags only the %s field when only that is wrong', async (_name, input, expected) => {
          const errors = realAddErrors(input);
          expect(errors).toHaveLength(1);
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors }) } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          await screen.findByRole('alert');
          expect(invalidState()).toMatchObject(expected);

          // only the field that is wrong is described, and by exactly its message
          const invalidLabel = Object.keys(expected).find((label) => expected[label] === 'true');
          expect(describedLabels()).toEqual([invalidLabel]);
          expect(screen.getByLabelText(invalidLabel)).toHaveAccessibleDescription(errors[0]);
        });

        it('a message about the form as a whole flags no field, but is still announced', async () => {
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors: ['Product not found.'] }) } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          expect(await screen.findByRole('alert')).toHaveTextContent('Product not found.');
          expect(invalidState()).toEqual({ Quantity: null, 'Cost per unit': null, 'Purchase date': null, Comment: null });
          expect(describedLabels()).toEqual([]); // a form-level message is not any field's description
        });

        it('a form-level message next to a field message: both are announced, but only the field message describes the field', async () => {
          const quantityMessage = realAddErrors({ quantity: 0 })[0];
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors: ['Product not found.', quantityMessage] }) } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          const list = await screen.findByRole('alert');
          expect(list).toHaveTextContent('Product not found.');
          expect(list).toHaveTextContent(quantityMessage);

          expect(screen.getByLabelText('Quantity')).toHaveAccessibleDescription(quantityMessage);
          expect(screen.getByLabelText('Quantity')).not.toHaveAccessibleDescription(expect.stringContaining('Product not found'));
          expect(describedLabels()).toEqual(['Quantity']);
        });

        it('a save failure is announced but described on no field, and clears the previous field description', async () => {
          const consoleError = captureConsoleError('Adding stock failed.');
          const addStock = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors: realAddErrors({ quantity: 0 }) })
            .mockRejectedValueOnce(new Error('write failed'));
          mount({ stock: { addStock } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          await waitFor(() => expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-describedby'));

          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
          fireEvent.click(screen.getByText('Save'));
          const alert = await screen.findByRole('alert'); // still announced
          expect(alert).toHaveTextContent("We couldn't save that stock change.");
          expect(alert).toHaveAttribute('id', 'add-form-submit-error');
          expect(describedLabels()).toEqual([]);
          expect(invalidState()).toEqual({ Quantity: null, 'Cost per unit': null, 'Purchase date': null, Comment: null });
          expect(consoleError).toHaveBeenCalledTimes(1);
        });

        it('the flags follow each attempt: a fixed field is cleared when a different one fails next', async () => {
          const addStock = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors: realAddErrors({ quantity: 0 }) })
            .mockResolvedValueOnce({ event: null, errors: realAddErrors({ quantity: 1, costPerUnit: -5 }) });
          mount({ stock: { addStock } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          await waitFor(() => expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-invalid', 'true'));

          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
          fireEvent.click(screen.getByText('Save'));
          await waitFor(() => expect(screen.getByLabelText('Cost per unit')).toHaveAttribute('aria-invalid', 'true'));
          expect(screen.getByLabelText('Quantity')).not.toHaveAttribute('aria-invalid');
          // and the descriptions follow: Quantity lost its message, Cost per unit has its own
          expect(screen.getByLabelText('Quantity')).not.toHaveAttribute('aria-describedby');
          expect(screen.getByLabelText('Cost per unit')).toHaveAccessibleDescription(realAddErrors({ quantity: 1, costPerUnit: -5 })[0]);
          expect(describedLabels()).toEqual(['Cost per unit']);
        });

        it('is cleared after a successful save and when the form is closed and reopened', async () => {
          const addStock = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors: realAddErrors({ quantity: 0 }) })
            .mockResolvedValueOnce({ event: { id: 'n1', appliedQuantity: 1 }, errors: [] });
          mount({ stock: { addStock } });
          await openAdd();
          fireEvent.click(screen.getByText('Save'));
          await waitFor(() => expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-invalid', 'true'));

          // close and reopen without saving
          fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
          await openAdd();
          expect(invalidState()).toEqual({ Quantity: null, 'Cost per unit': null, 'Purchase date': null, Comment: null });
          expect(describedLabels()).toEqual([]); // no stale association after close and reopen

          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
          fireEvent.click(screen.getByText('Save'));
          await screen.findByText('Stock increased by 1');
          expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument(); // form closed with the notice
        });

        it('remove form: the real quantity message flags Quantity, and clears on a successful save', async () => {
          const errors = realRemoveErrors({ quantity: 0 });
          expect(errors).toEqual(['Quantity must be greater than 0.']);
          const removeStock = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors })
            .mockResolvedValueOnce({ event: { id: 'r1', appliedQuantity: 1 }, errors: [] });
          mount({ stock: { removeStock } });
          await openRemove();
          expect(screen.getByLabelText('Quantity')).not.toHaveAttribute('aria-invalid');
          fireEvent.click(screen.getByText('Save'));

          const list = await screen.findByRole('alert');
          expect(screen.getByLabelText('Quantity')).toHaveAttribute('aria-invalid', 'true');
          expect(screen.getByLabelText('Quantity')).toHaveAccessibleDescription(errors[0]);
          expect(list).toContainElement(document.getElementById(screen.getByLabelText('Quantity').getAttribute('aria-describedby')));
          expect(screen.getByLabelText('Comment')).not.toHaveAttribute('aria-invalid');
          expect(screen.getByLabelText('Comment')).not.toHaveAttribute('aria-describedby');

          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
          fireEvent.click(screen.getByText('Save'));
          await screen.findByText('Stock reduced by 1');
          expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
        });
      });

      describe('validation errors are announced by the form and each described on its own field', () => {
        it('shows the service messages in one alert, and links each input to its own message with aria-describedby', async () => {
          // Real domain messages: a quantity error and a cost error, no date error.
          const errors = createAddStockEvent({ productId: 'p1', quantity: 0, costPerUnit: -1 }).errors;
          expect(errors).toHaveLength(2);
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors }) } });
          await openAdd();
          expect(screen.getByLabelText('Quantity')).not.toHaveAttribute('aria-describedby');
          fireEvent.click(screen.getByText('Save'));

          const list = await screen.findByRole('alert');
          expect(list).toHaveTextContent(errors[0]);
          expect(list).toHaveTextContent(errors[1]);
          expect(screen.getByLabelText('Quantity')).toHaveAccessibleDescription(errors[0]);
          expect(screen.getByLabelText('Cost per unit')).toHaveAccessibleDescription(errors[1]);
          // the date has no error, so it is not described by anyone else's
          expect(screen.getByLabelText('Purchase date')).not.toHaveAttribute('aria-describedby');
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

      it('on an unexpected failure: keeps the page and the entered values, shows a friendly error, and can retry', async () => {
        const consoleError = captureConsoleError('Adding stock failed.');
        const addStock = vi
          .fn()
          .mockRejectedValueOnce(new Error('write failed'))
          .mockResolvedValueOnce({ event: { id: 'n1', appliedQuantity: 6 }, errors: [] });
        mount({ stock: { addStock } });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '6' } });
        fireEvent.click(screen.getByText('Save'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("We couldn't save that stock change.");
        expect(alert).not.toHaveTextContent('write failed');
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
          'Adding stock failed.',
          expect.objectContaining({ message: 'write failed' })
        );
        // A save failure is about the operation, not any field: it is announced by its
        // own alert and is not part of any field's description.
        expect(alert).toHaveAttribute('id', 'add-form-submit-error');
        for (const label of ['Quantity', 'Cost per unit', 'Purchase date', 'Comment']) {
          expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-describedby');
          expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-invalid');
        }
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

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Only 10 units are currently available. Remove 25 anyway?');
        fireEvent.click(screen.getByText('Cancel'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

      it('announces a validation error in the form alert and describes the quantity input with it', async () => {
        mount({
          stock: { removeStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] }) }
        });
        await openRemove();
        fireEvent.click(screen.getByText('Save'));
        const list = await screen.findByRole('alert');
        expect(list).toHaveTextContent('Quantity must be greater than 0.');
        expect(screen.getByLabelText('Quantity')).toHaveAccessibleDescription('Quantity must be greater than 0.');
        expect(list).toContainElement(document.getElementById(screen.getByLabelText('Quantity').getAttribute('aria-describedby')));
      });

      it('reports a failure of the over-removal check without losing the page', async () => {
        const consoleError = captureConsoleError('Checking available stock failed.');
        mount({ stock: { wouldOverRemove: vi.fn().mockRejectedValue(new Error('check failed')) } });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Save'));
        const checkAlert = await screen.findByRole('alert');
        expect(checkAlert).toHaveTextContent("We couldn't check the available stock.");
        expect(checkAlert).not.toHaveTextContent('check failed');
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
          'Checking available stock failed.',
          expect.objectContaining({ message: 'check failed' })
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Parle-G' })).toBeInTheDocument();
      });

      it('an unexpected failure while removing stock shows a friendly message, keeps the entered values and can retry', async () => {
        const consoleError = captureConsoleError('Removing stock failed.');
        const removeStock = vi
          .fn()
          .mockRejectedValueOnce(new Error('disk full'))
          .mockResolvedValueOnce({ event: { id: 'r1', appliedQuantity: 2 }, errors: [] });
        mount({ stock: { removeStock } });
        await openRemove();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Save'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("We couldn't save that stock change.");
        expect(alert).not.toHaveTextContent('disk full');
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
          'Removing stock failed.',
          expect.objectContaining({ message: 'disk full' })
        );
        expect(alert).toHaveAttribute('id', 'remove-form-submit-error');
        for (const label of ['Quantity', 'Comment']) {
          expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-describedby');
          expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-invalid');
        }
        expect(screen.getByLabelText('Quantity')).toHaveValue(2);

        fireEvent.click(screen.getByText('Save'));
        expect(await screen.findByText('Stock reduced by 2')).toBeInTheDocument();
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
    // Phase 7H Slice 2: keyboard operation and focus management of the undo
    // notice and the over-removal dialog. jsdom has no real Tab key, native
    // Enter/Space activation or screen reader; those are covered by the real
    // browser pass, not here. These tests exercise focus placement, Escape,
    // timers, and exactly-once activation.
    describe('keyboard and focus (7H Slice 2)', () => {
      const T_ADD = { event: { id: 'new-event', appliedQuantity: 5 }, errors: [] };
      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };
      const noticeEl = () => document.querySelector('.undo-notice');
      const slot = () => document.querySelector('.undo-slot');
      const undoButton = () => screen.getByRole('button', { name: 'Undo' });
      const dismissButton = () => screen.getByRole('button', { name: 'Dismiss' });
      const focusOn = (el) => act(() => el.focus());
      const tabStops = () =>
        [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(
          (el) => !el.disabled && el.getAttribute('tabindex') !== '-1'
        );

      async function withFakeTimers(fn) {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          await fn();
        } finally {
          vi.useRealTimers();
        }
      }

      // Add 5 with focus on Save (as after a keyboard submit), wait for the notice.
      async function addWithFocusOnSave(stock = {}) {
        const ctx = mount({ stock: { addStock: vi.fn().mockResolvedValue(T_ADD), ...stock } });
        await openAdd();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
        focusOn(screen.getByText('Save'));
        fireEvent.click(screen.getByText('Save'));
        await screen.findByText('Stock increased by 5');
        return ctx;
      }

      describe('when a notice appears', () => {
        it('never takes focus; focus returns to Add Stock because the Save button that had it is gone', async () => {
          await addWithFocusOnSave();
          await waitFor(() => expect(screen.getByRole('button', { name: 'Add Stock' })).toHaveFocus());
          expect(noticeEl().contains(document.activeElement)).toBe(false);
        });

        it('after Remove Stock, focus returns to Remove Stock', async () => {
          mount({ stock: { removeStock: vi.fn().mockResolvedValue({ event: { id: 'r1', appliedQuantity: 3 }, errors: [] }) } });
          await openRemove();
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
          focusOn(screen.getByText('Save'));
          fireEvent.click(screen.getByText('Save'));
          await screen.findByText('Stock reduced by 3');
          await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Stock' })).toHaveFocus());
          expect(noticeEl().contains(document.activeElement)).toBe(false);
        });

        it('does not steal focus the user moved elsewhere while the save was running', async () => {
          const pending = deferred();
          mount({ stock: { addStock: vi.fn(() => pending.promise) } });
          await openAdd();
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
          focusOn(screen.getByText('Save'));
          fireEvent.click(screen.getByText('Save'));
          const edit = screen.getByRole('link', { name: 'Edit Product' });
          focusOn(edit);
          await act(async () => pending.resolve(T_ADD));
          await screen.findByText('Stock increased by 5');
          expect(edit).toHaveFocus();
        });

        it('leaves focus alone when it was not in the form (pointer user)', async () => {
          mount({ stock: { addStock: vi.fn().mockResolvedValue(T_ADD) } });
          await openAdd();
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
          fireEvent.click(screen.getByText('Save')); // click without focusing, as Safari does
          await screen.findByText('Stock increased by 5');
          expect(document.body).toHaveFocus();
        });

        it('Undo and Dismiss are native, enabled buttons directly after Remove Stock in tab order', async () => {
          await addWithFocusOnSave();
          const stops = tabStops();
          const remove = stops.indexOf(screen.getByRole('button', { name: 'Remove Stock' }));
          expect(stops.indexOf(undoButton())).toBe(remove + 1);
          expect(stops.indexOf(dismissButton())).toBe(remove + 2);
          for (const b of [undoButton(), dismissButton()]) {
            expect(b.tagName).toBe('BUTTON');
            expect(b).not.toHaveAttribute('tabindex');
            expect(b).not.toHaveAttribute('aria-hidden');
          }
        });
      });

      describe('Dismiss', () => {
        it('closes the notice WITHOUT reversing, and returns focus to the action that was used', async () => {
          const { stockEventService } = await addWithFocusOnSave();
          focusOn(dismissButton());
          fireEvent.click(dismissButton());
          expect(noticeEl()).toBeNull();
          expect(stockEventService.reverseEvent).not.toHaveBeenCalled();
          await waitFor(() => expect(screen.getByRole('button', { name: 'Add Stock' })).toHaveFocus());
        });

        it('leaves focus alone when it was not inside the notice', async () => {
          await addWithFocusOnSave();
          const edit = screen.getByRole('link', { name: 'Edit Product' });
          focusOn(edit);
          fireEvent.click(dismissButton());
          expect(noticeEl()).toBeNull();
          expect(edit).toHaveFocus();
        });
      });

      describe('Undo', () => {
        it('reverses exactly once, returns focus, and announces the result (then clears it)', async () => {
          await withFakeTimers(async () => {
            const { stockEventService } = await addWithFocusOnSave({
              reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] })
            });
            const region = slot();
            focusOn(undoButton());
            fireEvent.click(undoButton());

            await waitFor(() => expect(noticeEl()).toBeNull());
            expect(stockEventService.reverseEvent).toHaveBeenCalledTimes(1);
            expect(stockEventService.reverseEvent).toHaveBeenCalledWith('new-event');
            expect(screen.getByRole('button', { name: 'Add Stock' })).toHaveFocus();
            expect(slot()).toBe(region); // the live region persists
            expect(region).toHaveTextContent('Stock change undone.');
            expect(region.querySelector('.visually-hidden')).not.toBeNull();

            await act(async () => vi.advanceTimersByTimeAsync(5100));
            expect(region).toBeEmptyDOMElement(); // transient: nothing stale left behind
          });
        });

        it('two activations in the same tick reverse once; focus stays on Undo while it runs', async () => {
          const pending = deferred();
          const { stockEventService } = await addWithFocusOnSave({ reverseEvent: vi.fn(() => pending.promise) });
          focusOn(undoButton());
          fireEvent.click(undoButton());
          fireEvent.click(undoButton());
          fireEvent.click(undoButton());

          expect(stockEventService.reverseEvent).toHaveBeenCalledTimes(1);
          expect(undoButton()).toHaveAttribute('aria-disabled', 'true');
          expect(undoButton()).not.toBeDisabled(); // a disabled button would lose focus
          expect(undoButton()).toHaveFocus();

          await act(async () => pending.resolve({ event: { id: 'rev' }, errors: [] }));
          await waitFor(() => expect(noticeEl()).toBeNull());
          expect(stockEventService.reverseEvent).toHaveBeenCalledTimes(1);
        });

        it('a failed Undo keeps the notice, keeps focus on Undo, and can be retried', async () => {
          const reverseEvent = vi
            .fn()
            .mockResolvedValueOnce({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] })
            .mockResolvedValueOnce({ event: { id: 'rev' }, errors: [] });
          await addWithFocusOnSave({
            getHistory: vi.fn().mockResolvedValue([ev('new-event', { quantity: 5, recordedAt: T1 })]),
            reverseEvent
          });
          focusOn(undoButton());
          fireEvent.click(undoButton());
          await screen.findByText('Cannot reverse: current stock is insufficient.');

          expect(noticeEl()).not.toBeNull();
          expect(undoButton()).not.toHaveAttribute('aria-disabled');
          expect(undoButton()).toHaveFocus();

          fireEvent.click(undoButton());
          await waitFor(() => expect(noticeEl()).toBeNull());
          expect(reverseEvent).toHaveBeenCalledTimes(2);
        });

        it('reversing from the history list is announced as reversed', async () => {
          mount({
            history: [ev('e1', { quantity: 5, recordedAt: T1 })],
            stock: { reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) }
          });
          fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));
          await waitFor(() => expect(slot()).toHaveTextContent('Stock change reversed.'));
        });
      });

      describe('reversing from the history list', () => {
        const reverseButton = () => screen.getByRole('button', { name: 'Reverse this action' });
        const history = () => [ev('e1', { quantity: 5, recordedAt: T1 })];
        const historyHeading = () => screen.getByRole('heading', { level: 2, name: 'Stock History' });

        it('on success the entry button is gone, so focus lands on the Stock History heading (a script-only focus target)', async () => {
          mount({ history: history(), stock: { reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) } });
          await screen.findByRole('button', { name: 'Reverse this action' });
          focusOn(reverseButton());
          fireEvent.click(reverseButton());

          await waitFor(() => expect(historyHeading()).toHaveFocus());
          expect(historyHeading()).toHaveAttribute('tabindex', '-1'); // not an extra Tab stop
          expect(slot()).toHaveTextContent('Stock change reversed.');
        });

        // Real browsers drop focus to <body> when the focused button becomes
        // disabled (the buttons are disabled while a reversal runs); jsdom does
        // not, so the tests reproduce it. Without this the "restore" has nothing
        // to restore and a regression would go unnoticed. (blur() cannot do it:
        // jsdom ignores blur() on a disabled element, so body is focused instead.)
        const browserDropsFocusOfDisabledButton = () =>
          act(() => {
            document.body.tabIndex = -1;
            document.body.focus();
            document.body.removeAttribute('tabindex');
          });

        it('on a service error focus returns to that same entry button, which is enabled again', async () => {
          const pending = deferred();
          mount({ history: history(), stock: { reverseEvent: vi.fn(() => pending.promise) } });
          await screen.findByRole('button', { name: 'Reverse this action' });
          focusOn(reverseButton());
          fireEvent.click(reverseButton());
          expect(reverseButton()).toBeDisabled();
          browserDropsFocusOfDisabledButton();
          expect(document.body).toHaveFocus();

          await act(async () =>
            pending.resolve({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] })
          );
          await screen.findByText('Cannot reverse: current stock is insufficient.');
          await waitFor(() => expect(reverseButton()).toHaveFocus());
          expect(reverseButton()).toBeEnabled();
        });

        it('on an unexpected failure focus also returns to that entry button', async () => {
          const consoleError = captureConsoleError('Reversing a stock event failed.');
          const pending = deferred();
          mount({ history: history(), stock: { reverseEvent: vi.fn(() => pending.promise) } });
          await screen.findByRole('button', { name: 'Reverse this action' });
          focusOn(reverseButton());
          fireEvent.click(reverseButton());
          browserDropsFocusOfDisabledButton();
          expect(document.body).toHaveFocus();

          await act(async () => pending.reject(new Error('boom')));
          expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't undo that change.");
          await waitFor(() => expect(reverseButton()).toHaveFocus());
          expect(consoleError).toHaveBeenCalledTimes(1);
        });

        it('does not steal focus the user moved elsewhere while the reversal was running', async () => {
          const pending = deferred();
          mount({ history: history(), stock: { reverseEvent: vi.fn(() => pending.promise) } });
          await screen.findByRole('button', { name: 'Reverse this action' });
          focusOn(reverseButton());
          fireEvent.click(reverseButton());
          const edit = screen.getByRole('link', { name: 'Edit Product' });
          focusOn(edit);
          await act(async () => pending.resolve({ event: { id: 'rev' }, errors: [] }));
          await waitFor(() => expect(slot()).toHaveTextContent('Stock change reversed.'));
          expect(edit).toHaveFocus();
        });

        it('leaves focus alone for a pointer user whose click never focused the button', async () => {
          mount({ history: history(), stock: { reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) } });
          await screen.findByRole('button', { name: 'Reverse this action' });
          fireEvent.click(reverseButton()); // click without focusing, as Safari does
          await waitFor(() => expect(slot()).toHaveTextContent('Stock change reversed.'));
          expect(document.body).toHaveFocus();
        });
      });

      // Phase 7H Slice 3. These count every live region that currently carries
      // text, so a second mechanism announcing the same event (a status badge, a
      // description re-read on focus, a region that is also focused) fails here.
      // They pin the semantics only: what a screen reader actually speaks is not
      // something jsdom can show.
      describe('one event, one announcement', () => {
        const LIVE = '[role="status"], [role="alert"], [role="log"], [aria-live]';
        const announcing = () => [...document.querySelectorAll(LIVE)].filter((el) => el.textContent.trim() !== '');

        it('adding stock to an out-of-stock product is announced once: the notice, not also the Out of Stock badge', async () => {
          mount({
            product: { ...SAMPLE_PRODUCT, quantity: 0 },
            stock: { addStock: vi.fn().mockResolvedValue(T_ADD) }
          });
          await openAdd();
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
          fireEvent.click(screen.getByText('Save'));
          await screen.findByText('Stock increased by 5');

          expect(screen.getByText('Out of Stock')).toBeInTheDocument(); // still shown, as text
          const regions = announcing();
          expect(regions).toHaveLength(1);
          expect(regions[0]).toBe(slot());
          expect(regions[0]).toHaveTextContent('Stock increased by 5');
        });

        it('undoing it is announced once, by the same region, and the old message is gone', async () => {
          await addWithFocusOnSave({ reverseEvent: vi.fn().mockResolvedValue({ event: { id: 'rev' }, errors: [] }) });
          fireEvent.click(undoButton());
          await waitFor(() => expect(slot()).toHaveTextContent('Stock change undone.'));

          const regions = announcing();
          expect(regions).toHaveLength(1);
          expect(regions[0]).toBe(slot());
          expect(regions[0]).not.toHaveTextContent('Stock increased by 5');
        });

        it('a failed Undo is announced once, as an alert, and the notice stays silent', async () => {
          await addWithFocusOnSave({
            getHistory: vi.fn().mockResolvedValue([ev('new-event', { quantity: 5, recordedAt: T1 })]),
            reverseEvent: vi.fn().mockResolvedValue({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] })
          });
          const before = announcing().map((el) => el.textContent.trim());
          expect(before).toHaveLength(1); // just the notice, which announced when it appeared
          fireEvent.click(undoButton());
          await screen.findByText('Cannot reverse: current stock is insufficient.');

          const alerts = [...document.querySelectorAll('[role="alert"]')].filter((el) => el.textContent.trim() !== '');
          expect(alerts).toHaveLength(1);
          expect(alerts[0]).toHaveTextContent('Cannot reverse: current stock is insufficient.');
          expect(slot()).not.toHaveTextContent('Cannot reverse');
        });

        it('a validation failure is announced once (the alert); the Save button that gets focus back does not repeat it', async () => {
          mount({ stock: { addStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] }) } });
          await openAdd();
          focusOn(screen.getByText('Save'));
          fireEvent.click(screen.getByText('Save'));
          const alert = await screen.findByRole('alert');

          await waitFor(() => expect(screen.getByText('Save')).toHaveFocus()); // focus is restored to Save...
          expect(announcing()).toEqual([alert]); // ...and the alert is the only thing announcing
          expect(screen.getByText('Save')).not.toHaveAttribute('aria-describedby'); // ...and Save does not re-read it
        });
      });

      describe('keeping the fixed notice from covering content or focus', () => {
        const property = () => document.documentElement.style.getPropertyValue('--undo-clearance');
        let rectTop;
        let rectSpy;
        beforeEach(() => {
          rectTop = 500;
          rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
            top: rectTop, bottom: rectTop + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: rectTop, toJSON() {}
          }));
        });
        afterEach(() => {
          rectSpy.mockRestore();
          document.documentElement.style.removeProperty('--undo-clearance');
        });

        it('publishes how much of the viewport bottom the notice covers while it is shown, and clears it afterwards', async () => {
          expect(property()).toBe('');
          await addWithFocusOnSave();
          expect(property()).toBe(`${Math.ceil(window.innerHeight - 500) + 8}px`);

          fireEvent.click(dismissButton());
          expect(property()).toBe('');
        });

        it('follows a resize while the notice is shown', async () => {
          await addWithFocusOnSave();
          rectTop = 300;
          act(() => {
            window.dispatchEvent(new Event('resize'));
          });
          expect(property()).toBe(`${Math.ceil(window.innerHeight - 300) + 8}px`);
        });

        it('is cleared when the notice expires', async () => {
          await withFakeTimers(async () => {
            await addWithFocusOnSave();
            expect(property()).not.toBe('');
            await act(async () => vi.advanceTimersByTimeAsync(5100));
            expect(property()).toBe('');
          });
        });

        it('is cleared when the page unmounts with the notice still up', async () => {
          await addWithFocusOnSave();
          expect(property()).not.toBe('');
          cleanup(); // unmounts the rendered page
          expect(property()).toBe('');
        });
      });

      describe('expiry', () => {
        const stillThere = () => expect(screen.getByText('Stock increased by 5')).toBeInTheDocument();
        const gone = () => expect(screen.queryByText('Stock increased by 5')).not.toBeInTheDocument();
        const advance = (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));

        it('is paused while the pointer is over the notice, then restarts the full duration', async () => {
          await withFakeTimers(async () => {
            await addWithFocusOnSave();
            fireEvent.mouseEnter(noticeEl());
            await advance(20000);
            stillThere();
            fireEvent.mouseLeave(noticeEl());
            await advance(4900);
            stillThere();
            await advance(200);
            gone();
          });
        });

        it('is paused while focus is inside the notice, including when moving between its buttons', async () => {
          await withFakeTimers(async () => {
            await addWithFocusOnSave();
            focusOn(undoButton());
            await advance(6000);
            stillThere();
            focusOn(dismissButton()); // Undo -> Dismiss: still inside the notice
            await advance(6000);
            stillThere();
            act(() => dismissButton().blur()); // focus leaves
            await advance(4900);
            stillThere();
            await advance(200);
            gone();
          });
        });

        it('does not expire while a reversal is in flight, and the notice survives its failure', async () => {
          await withFakeTimers(async () => {
            const pending = deferred();
            await addWithFocusOnSave({
              getHistory: vi.fn().mockResolvedValue([ev('new-event', { quantity: 5, recordedAt: T1 })]),
              reverseEvent: vi.fn(() => pending.promise)
            });
            fireEvent.click(undoButton());
            await advance(10000);
            stillThere();
            await act(async () => pending.resolve({ event: null, errors: ['Cannot reverse: current stock is insufficient.'] }));
            await advance(100);
            stillThere(); // the failed Undo can be retried
            await advance(5100);
            gone(); // and it expires normally once nothing is happening
          });
        });

        it('a second stock change replaces the notice and restarts the expiry', async () => {
          await withFakeTimers(async () => {
            const addStock = vi
              .fn()
              .mockResolvedValueOnce(T_ADD)
              .mockResolvedValueOnce({ event: { id: 'e2', appliedQuantity: 7 }, errors: [] });
            mount({ stock: { addStock } });
            const add = async (qty) => {
              fireEvent.click(await screen.findByRole('button', { name: 'Add Stock' }));
              fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: qty } });
              fireEvent.click(screen.getByText('Save'));
            };
            await add('5');
            await screen.findByText('Stock increased by 5');
            await advance(3000);
            await add('7');
            await screen.findByText('Stock increased by 7');
            await advance(3000); // 6 s after the first, 3 s after the second
            expect(screen.getByText('Stock increased by 7')).toBeInTheDocument();
            await advance(2100);
            expect(screen.queryByText('Stock increased by 7')).not.toBeInTheDocument();
          });
        });

        it('a hover that never sent mouseleave cannot freeze the NEXT notice', async () => {
          await withFakeTimers(async () => {
            await addWithFocusOnSave();
            fireEvent.mouseEnter(noticeEl());
            fireEvent.click(dismissButton()); // notice removed while "hovered"
            fireEvent.click(screen.getByRole('button', { name: 'Add Stock' }));
            fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
            fireEvent.click(screen.getByText('Save'));
            await screen.findByText('Stock increased by 5');
            await advance(5100);
            gone();
          });
        });
      });

      describe('over-removal dialog', () => {
        const OVER = () => ({
          wouldOverRemove: vi.fn().mockResolvedValue(true),
          removeStock: vi.fn().mockResolvedValue({ event: { id: 'r1', appliedQuantity: 10 }, errors: [] })
        });

        async function openWarning(stock = OVER()) {
          const ctx = mount({ stock });
          await openRemove();
          fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '25' } });
          focusOn(screen.getByText('Save'));
          fireEvent.click(screen.getByText('Save'));
          const dialog = await screen.findByRole('dialog');
          return { ...ctx, dialog };
        }

        it('has an accessible name and a description that resolves to the warning text', async () => {
          await openWarning();
          const dialog = screen.getByRole('dialog', { name: 'Remove more than the available stock?' });
          const description = document.getElementById(dialog.getAttribute('aria-describedby'));
          expect(description).toHaveTextContent('Only 10 units are currently available. Remove 25 anyway?');
        });

        it('is a plain, non-modal dialog (not an alertdialog): focus is free to leave and the page behind stays interactive', async () => {
          await openWarning();
          const dialog = screen.getByRole('dialog', { name: 'Remove more than the available stock?' });
          expect(dialog).toHaveAttribute('role', 'dialog');
          expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
          expect(dialog).not.toHaveAttribute('aria-modal', 'true');

          // Nothing behind it is hidden from assistive technology or inert...
          const quantity = screen.getByLabelText('Quantity');
          const edit = screen.getByRole('link', { name: 'Edit Product' });
          for (const el of [quantity, edit]) expect(el.closest('[aria-hidden="true"], [inert]')).toBeNull();
          // ...and focus is not trapped: it can move out of the dialog and the dialog stays open.
          focusOn(quantity);
          expect(quantity).toHaveFocus();
          focusOn(edit);
          expect(edit).toHaveFocus();
          expect(screen.getByRole('dialog')).toBeInTheDocument();
        });

        it('opens with focus on Cancel (the safe choice), never on Continue, and removes nothing', async () => {
          const { stockEventService } = await openWarning();
          await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
          expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveFocus();
          expect(stockEventService.removeStock).not.toHaveBeenCalled();
        });

        it('Escape cancels without removing, keeps what was typed, and returns focus to Save', async () => {
          const { stockEventService } = await openWarning();
          fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
          expect(stockEventService.removeStock).not.toHaveBeenCalled();
          expect(screen.getByLabelText('Quantity')).toHaveValue(25);
          await waitFor(() => expect(screen.getByText('Save')).toHaveFocus());
        });

        it('Escape pressed outside the dialog does not dismiss it', async () => {
          await openWarning();
          fireEvent.keyDown(screen.getByLabelText('Quantity'), { key: 'Escape' });
          expect(screen.getByRole('dialog')).toBeInTheDocument();
        });

        it('other keys do nothing', async () => {
          const { stockEventService } = await openWarning();
          fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' });
          fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: ' ' });
          expect(screen.getByRole('dialog')).toBeInTheDocument();
          expect(stockEventService.removeStock).not.toHaveBeenCalled();
        });

        it('the Cancel button also returns focus to Save', async () => {
          await openWarning();
          fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
          await waitFor(() => expect(screen.getByText('Save')).toHaveFocus());
        });

        it('Continue removes exactly the warned quantity once, then returns focus to Remove Stock (the form is gone)', async () => {
          const { stockEventService } = await openWarning();
          focusOn(screen.getByRole('button', { name: 'Continue' }));
          fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

          expect(await screen.findByText('Stock reduced by 10')).toBeInTheDocument();
          expect(stockEventService.removeStock).toHaveBeenCalledTimes(1);
          expect(stockEventService.removeStock).toHaveBeenCalledWith({ productId: 'p1', quantity: 25, comment: '' });
          await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Stock' })).toHaveFocus());
          expect(noticeEl().contains(document.activeElement)).toBe(false);
        });

        it('if Continue fails, the form is still there and focus returns to Save', async () => {
          await openWarning({
            ...OVER(),
            removeStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] })
          });
          focusOn(screen.getByRole('button', { name: 'Continue' }));
          fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
          await screen.findByText('Quantity must be greater than 0.');
          await waitFor(() => expect(screen.getByText('Save')).toHaveFocus());
        });
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
          const consoleError = captureConsoleError('Reversing a stock event failed.');
          mount({
            history: [ev('b')],
            stock: { reverseEvent: vi.fn().mockRejectedValue(new Error('reversal exploded')) }
          });
          fireEvent.click(await screen.findByRole('button', { name: 'Reverse this action' }));
          expect(await screen.findByText("We couldn't undo that change. Please try again.")).toBeInTheDocument();
          expect(screen.queryByText('reversal exploded')).not.toBeInTheDocument();
          expect(consoleError).toHaveBeenCalledTimes(1);
          expect(consoleError).toHaveBeenCalledWith(
            'Reversing a stock event failed.',
            expect.objectContaining({ message: 'reversal exploded' })
          );
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
