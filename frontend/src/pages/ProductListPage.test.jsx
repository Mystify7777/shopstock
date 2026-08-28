import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProductListPage from './ProductListPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

// These tests exercise UI behavior only. productService is mocked here --
// the real service -> repository -> Dexie path is already covered by
// src/services/productService.test.js. Mocking the boundary this test
// actually owns (the page's consumption of service results) keeps each
// layer's tests scoped to what it is responsible for.

function makeMockService(overrides = {}) {
  return {
    listProducts: vi.fn().mockResolvedValue([]),
    getProduct: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    searchProducts: vi.fn().mockResolvedValue({ matches: [], related: [], hasExactMatch: false }),
    ...overrides
  };
}

// Small helper: renders ProductListPage under real routes so navigation can
// be observed via a visible current-path indicator, without pulling in the
// real ProductFormPage.
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderWithRoutes(productService) {
  return render(
    <AppProvider services={{ productService }}>
      <MemoryRouter initialEntries={['/products']}>
        <Routes>
          <Route path="/products" element={<ProductListPage />} />
          <Route path="/products/new" element={<div>New product form</div>} />
          <Route path="/products/:id" element={<div>Product detail page</div>} />
          <Route path="/products/:id/edit" element={<div>Edit product form</div>} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </AppProvider>
  );
}

describe('ProductListPage', () => {
  it('shows a loading state before products resolve', () => {
    const productService = makeMockService({
      listProducts: vi.fn(() => new Promise(() => {})) // never resolves
    });
    renderWithRoutes(productService);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no products', async () => {
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([])
    });
    renderWithRoutes(productService);
    await waitFor(() => {
      expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
    });
  });

  it('renders a list of products once loaded', async () => {
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'Parle-G', quantity: 12 },
        { id: 'p2', name: 'Good Day', quantity: 5 }
      ])
    });
    renderWithRoutes(productService);
    await waitFor(() => {
      expect(screen.getByText(/Parle-G/)).toBeInTheDocument();
      expect(screen.getByText(/Good Day/)).toBeInTheDocument();
    });
  });

  it('navigates to /products/new when Add Product is clicked', async () => {
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([])
    });
    renderWithRoutes(productService);

    await waitFor(() => screen.getByText(/no products yet/i));
    fireEvent.click(screen.getByText('Add Product'));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/products/new');
    });
  });

  it('navigates to /products/:id when a product row is clicked', async () => {
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'Parle-G', quantity: 12 }
      ])
    });
    renderWithRoutes(productService);

    await waitFor(() => screen.getByText(/Parle-G/));
    fireEvent.click(screen.getByText(/Parle-G/));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/products/p1');
    });
  });

  it('renders the error state when listProducts rejects', async () => {
    const productService = makeMockService({
      listProducts: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    renderWithRoutes(productService);

    await waitFor(() => {
      expect(screen.getByText('database unavailable')).toBeInTheDocument();
    });
  });

  it('renders a low-stock indicator for a product at or below the default threshold', async () => {
    // DEFAULT_LOW_STOCK_THRESHOLD is 5 -- quantity 3 is LOW (0 < 3 <= 5).
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'Low Stock Item', quantity: 3 },
      ]),
    });
    renderWithRoutes(productService);

    await waitFor(() => {
      expect(screen.getByText(/Low Stock Item/)).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
  });

  it('does not render a low-stock indicator for a normal-stock product', async () => {
    // quantity 50 is well above the default threshold of 5 -- Normal.
    const productService = makeMockService({
      listProducts: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'Well Stocked Item', quantity: 50 },
      ]),
    });
    renderWithRoutes(productService);

    await waitFor(() => {
      expect(screen.getByText(/Well Stocked Item/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // ===========================================================================
  // Search (Phase 4A)
  // ===========================================================================

  describe('search', () => {
    it('renders a search input', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([])
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));
      expect(screen.getByLabelText(/search/i)).toBeInTheDocument();
    });

    it('typing updates the query input value', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([])
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      const input = screen.getByLabelText(/search/i);
      fireEvent.change(input, { target: { value: 'parle' } });
      expect(input).toHaveValue('parle');
    });

    it('does not call searchProducts before the debounce window elapses', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([])
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      vi.useFakeTimers();
      const input = screen.getByLabelText(/search/i);
      fireEvent.change(input, { target: { value: 'parle' } });

      await vi.advanceTimersByTimeAsync(200);
      expect(productService.searchProducts).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('calls searchProducts once the debounce window elapses', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({
          matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
          related: [],
          hasExactMatch: true
        })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      vi.useFakeTimers();
      const input = screen.getByLabelText(/search/i);
      fireEvent.change(input, { target: { value: 'Parle-G' } });

      await vi.advanceTimersByTimeAsync(450);
      expect(productService.searchProducts).toHaveBeenCalledWith('Parle-G');

      vi.useRealTimers();
    });

    it('rapid typing collapses to a single searchProducts call with the final value', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({ matches: [], related: [], hasExactMatch: false })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      vi.useFakeTimers();
      const input = screen.getByLabelText(/search/i);
      fireEvent.change(input, { target: { value: 'p' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(input, { target: { value: 'pa' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(input, { target: { value: 'parle' } });
      await vi.advanceTimersByTimeAsync(450);

      expect(productService.searchProducts).toHaveBeenCalledTimes(1);
      expect(productService.searchProducts).toHaveBeenCalledWith('parle');

      vi.useRealTimers();
    });

    it('renders matching search results', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({
          matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
          related: [],
          hasExactMatch: true
        })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'Parle-G' } });

      await waitFor(() => {
        expect(screen.getByText(/Parle-G/)).toBeInTheDocument();
      });
    });

    it('clearing the search input restores the normal product list', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([
          { id: 'p1', name: 'Good Day', quantity: 8 }
        ]),
        searchProducts: vi.fn().mockResolvedValue({
          matches: [{ id: 'p2', name: 'Parle-G', quantity: 10 }],
          related: [],
          hasExactMatch: true
        })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/Good Day/));

      const input = screen.getByLabelText(/search/i);
      fireEvent.change(input, { target: { value: 'Parle-G' } });
      await waitFor(() => screen.getByText(/Parle-G/));

      fireEvent.change(input, { target: { value: '' } });
      await waitFor(() => {
        expect(screen.getByText(/Good Day/)).toBeInTheDocument();
        expect(screen.queryByText(/Parle-G/)).not.toBeInTheDocument();
      });
    });

    it('shows an empty search-results state distinct from the normal empty state', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({ matches: [], related: [], hasExactMatch: false })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'zzznomatch' } });

      await waitFor(() => {
        expect(screen.getByText(/no products match your search/i)).toBeInTheDocument();
      });
    });

    it('existing navigation still works from a search result row', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({
          matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
          related: [],
          hasExactMatch: true
        })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'Parle-G' } });
      await waitFor(() => screen.getByText(/Parle-G/));
      fireEvent.click(screen.getByText(/Parle-G/));

      await waitFor(() => {
        expect(screen.getByTestId('location')).toHaveTextContent('/products/p1');
      });
    });

    it('existing low-stock indicator still renders on a search result row', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([]),
        searchProducts: vi.fn().mockResolvedValue({
          matches: [{ id: 'p1', name: 'Low Stock Item', quantity: 3 }],
          related: [],
          hasExactMatch: true
        })
      });
      renderWithRoutes(productService);
      await waitFor(() => screen.getByText(/no products yet/i));

      fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'Low Stock' } });

      await waitFor(() => {
        expect(screen.getByText(/Low Stock Item/)).toBeInTheDocument();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
    });
  });
});
