import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
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

function makeMockClassificationRepository(overrides = {}) {
  return {
    list: vi.fn().mockResolvedValue([]),
    ...overrides
  };
}

// Minimal fake SpeechRecognition constructor, matching the one used in
// useSpeechRecognition.test.js -- these UI tests exercise the mic
// button's integration with the existing search flow, not the hook's own
// internals (already covered there).
function makeFakeRecognitionCtor() {
  const instances = [];

  function FakeSpeechRecognition() {
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.stop = vi.fn();
    this.abort = vi.fn();
    this.start = vi.fn(() => {
      this.onstart?.();
    });
    instances.push(this);
  }

  FakeSpeechRecognition.instances = instances;
  return FakeSpeechRecognition;
}

function installFakeSpeechRecognition() {
  const Ctor = makeFakeRecognitionCtor();
  window.SpeechRecognition = Ctor;
  return Ctor;
}

// Small helper: renders ProductListPage under real routes so navigation can
// be observed via a visible current-path indicator, without pulling in the
// real ProductFormPage.
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderWithRoutes(productService, classificationRepository = makeMockClassificationRepository()) {
  return render(
    <AppProvider services={{ productService, classificationRepository }}>
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
  // Safety net for the fake-timer usage inside the debounce tests below --
  // if a fake-timer test throws before its own vi.useRealTimers() call,
  // fake timers would otherwise leak into every subsequent test in this
  // file and hang their waitFor() calls (the exact bug the Phase 4A
  // corrective pass already fixed once in useDebouncedValue.test.js).
  afterEach(() => {
    vi.useRealTimers();
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });

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
      expect(productService.searchProducts).toHaveBeenCalledWith('Parle-G', { categoryId: null, locationIds: [], tagIds: [] });

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
      expect(productService.searchProducts).toHaveBeenCalledWith('parle', { categoryId: null, locationIds: [], tagIds: [] });

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

    describe('related products (Phase 4B)', () => {
      it('exact match suppresses the Related products section', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [{ id: 'p2', name: 'Good Day', quantity: 5 }],
            hasExactMatch: true
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'Parle-G' } });
        await waitFor(() => screen.getByText(/Parle-G/));

        expect(screen.queryByText(/related products/i)).not.toBeInTheDocument();
      });

      it('fuzzy-only query still renders closest matches', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });

        await waitFor(() => {
          expect(screen.getByText(/Parle-G/)).toBeInTheDocument();
        });
      });

      it('fuzzy-only query renders Related products when available', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [{ id: 'p2', name: 'Good Day', quantity: 5 }],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });

        await waitFor(() => {
          expect(screen.getByText(/related products/i)).toBeInTheDocument();
          expect(screen.getByText(/Good Day/)).toBeInTheDocument();
        });
      });

      it('Related products are structurally separate from closest matches', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [{ id: 'p2', name: 'Good Day', quantity: 5 }],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });
        await waitFor(() => screen.getByText(/Good Day/));

        const heading = screen.getByRole('heading', { name: /related products/i });
        const section = heading.closest('section');
        expect(section).not.toBeNull();
        expect(section).toContainElement(screen.getByText(/Good Day/));
        // The closest-match row lives outside the related section.
        expect(section).not.toContainElement(screen.getByText(/Parle-G/));
      });

      it('related rows preserve navigation to /products/:id', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [{ id: 'p2', name: 'Good Day', quantity: 5 }],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });
        await waitFor(() => screen.getByText(/Good Day/));
        fireEvent.click(screen.getByText(/Good Day/));

        await waitFor(() => {
          expect(screen.getByTestId('location')).toHaveTextContent('/products/p2');
        });
      });

      it('related rows preserve low-stock indicator rendering', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [{ id: 'p2', name: 'Low Stock Related', quantity: 3 }],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });

        await waitFor(() => {
          expect(screen.getByText(/Low Stock Related/)).toBeInTheDocument();
        });
        expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
      });

      it('renders no Related products section at all when related is empty', async () => {
        const productService = makeMockService({
          listProducts: vi.fn().mockResolvedValue([]),
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });
        await waitFor(() => screen.getByText(/Parle-G/));

        expect(screen.queryByRole('heading', { name: /related products/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/related products/i)).not.toBeInTheDocument();
      });
    });

    describe('filters (Phase 4C)', () => {
      function makeOptions() {
        return makeMockClassificationRepository({
          list: vi.fn((entityType) => {
            if (entityType === 'category') {
              return Promise.resolve([{ id: 'cat-snacks', name: 'Snacks' }, { id: 'cat-cleaning', name: 'Cleaning' }]);
            }
            if (entityType === 'location') {
              return Promise.resolve([{ id: 'loc-a', name: 'Shelf A' }, { id: 'loc-b', name: 'Warehouse' }]);
            }
            if (entityType === 'tag') {
              return Promise.resolve([{ id: 'tag-popular', name: 'Popular' }, { id: 'tag-sale', name: 'Sale' }]);
            }
            return Promise.resolve([]);
          })
        });
      }

      it('filter controls populate from active classifications', async () => {
        const productService = makeMockService();
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));

        expect(await screen.findByText('Snacks')).toBeInTheDocument();
        expect(screen.getByText('Cleaning')).toBeInTheDocument();
        expect(screen.getByText('Shelf A')).toBeInTheDocument();
        expect(screen.getByText('Warehouse')).toBeInTheDocument();
        expect(screen.getByText('Popular')).toBeInTheDocument();
        expect(screen.getByText('Sale')).toBeInTheDocument();
      });

      it('selecting a category filter triggers a search call with the right filter payload', async () => {
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Chips', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Snacks');

        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat-snacks' } });

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalledWith(
            '',
            expect.objectContaining({ categoryId: 'cat-snacks' })
          );
        });
        expect(await screen.findByText(/Chips/)).toBeInTheDocument();
      });

      it('selecting multiple locations/tags is reflected in the search call payload', async () => {
        const productService = makeMockService();
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Shelf A');

        fireEvent.click(screen.getByLabelText('Shelf A'));
        fireEvent.click(screen.getByLabelText('Warehouse'));
        fireEvent.click(screen.getByLabelText('Popular'));

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalledWith(
            '',
            expect.objectContaining({
              locationIds: expect.arrayContaining(['loc-a', 'loc-b']),
              tagIds: expect.arrayContaining(['tag-popular'])
            })
          );
        });
      });

      it('"Clear filters" resets state and re-triggers back to the unfiltered list', async () => {
        const productService = makeMockService();
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Shelf A');

        fireEvent.click(screen.getByLabelText('Shelf A'));
        await waitFor(() => {
          expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));

        await waitFor(() => {
          expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
        });
      });

      it('filters-only (no text typed) still produces and displays results', async () => {
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Detergent', quantity: 4 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Cleaning');

        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat-cleaning' } });

        expect(await screen.findByText(/Detergent/)).toBeInTheDocument();
        // Confirms the query field itself is still empty -- this is the
        // "filters only" path, not a leftover text search.
        expect(screen.getByLabelText(/search/i)).toHaveValue('');
      });

      it('combined text + filters render correctly', async () => {
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService, makeOptions());
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Snacks');

        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat-snacks' } });
        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'parleg' } });

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalledWith(
            'parleg',
            expect.objectContaining({ categoryId: 'cat-snacks' })
          );
        });
        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
      });

      it('changing filters does not repeatedly reload classification options', async () => {
        const classificationRepository = makeOptions();
        const productService = makeMockService();
        renderWithRoutes(productService, classificationRepository);
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Shelf A');

        const callsAfterMount = classificationRepository.list.mock.calls.length;
        expect(callsAfterMount).toBeGreaterThan(0);

        fireEvent.click(screen.getByLabelText('Shelf A'));
        fireEvent.click(screen.getByLabelText('Warehouse'));
        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat-snacks' } });
        fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'chips' } });

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalled();
        });

        expect(classificationRepository.list.mock.calls.length).toBe(callsAfterMount);
      });
    });

    describe('voice search (Phase 4D)', () => {
      it('mic button is not rendered when speech recognition is unsupported', async () => {
        const productService = makeMockService();
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        expect(screen.queryByLabelText(/search by voice/i)).not.toBeInTheDocument();
      });

      it('mic button is rendered when speech recognition is supported', async () => {
        installFakeSpeechRecognition();
        const productService = makeMockService();
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        expect(screen.getByLabelText(/search by voice/i)).toBeInTheDocument();
      });

      it('a final transcript populates the existing search input', async () => {
        const Ctor = installFakeSpeechRecognition();
        const productService = makeMockService();
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.click(screen.getByLabelText(/search by voice/i));
        const instance = Ctor.instances[0];
        instance.onresult({ results: [[{ transcript: 'Parle-G' }]] });

        await waitFor(() => {
          expect(document.getElementById('product-search')).toHaveValue('Parle-G');
        });
      });

      it('a voice transcript flows through the existing debounced search path', async () => {
        const Ctor = installFakeSpeechRecognition();
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.click(screen.getByLabelText(/search by voice/i));
        const instance = Ctor.instances[0];
        instance.onresult({ results: [[{ transcript: 'parleg' }]] });

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalledWith(
            'parleg',
            expect.objectContaining({ categoryId: null, locationIds: [], tagIds: [] })
          );
        });
        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
      });

      it('filters remain intact when voice updates the query', async () => {
        const Ctor = installFakeSpeechRecognition();
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Chips', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        const classificationRepository = makeMockClassificationRepository({
          list: vi.fn((entityType) =>
            entityType === 'category'
              ? Promise.resolve([{ id: 'cat-snacks', name: 'Snacks' }])
              : Promise.resolve([])
          )
        });
        renderWithRoutes(productService, classificationRepository);
        await waitFor(() => screen.getByText(/no products yet/i));
        await screen.findByText('Snacks');

        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat-snacks' } });

        fireEvent.click(screen.getByLabelText(/search by voice/i));
        const instance = Ctor.instances[0];
        instance.onresult({ results: [[{ transcript: 'chips' }]] });

        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalledWith(
            'chips',
            expect.objectContaining({ categoryId: 'cat-snacks' })
          );
        });
      });

      it('a voice error renders without breaking typed search', async () => {
        const Ctor = installFakeSpeechRecognition();
        const productService = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [{ id: 'p1', name: 'Parle-G', quantity: 10 }],
            related: [],
            hasExactMatch: false
          })
        });
        renderWithRoutes(productService);
        await waitFor(() => screen.getByText(/no products yet/i));

        fireEvent.click(screen.getByLabelText(/search by voice/i));
        const instance = Ctor.instances[0];
        instance.onerror({ error: 'no-speech' });

        expect(await screen.findByText(/Couldn't hear anything/i)).toBeInTheDocument();

        // Typed search still works normally after a voice error.
        fireEvent.change(document.getElementById('product-search'), { target: { value: 'parleg' } });
        await waitFor(() => {
          expect(productService.searchProducts).toHaveBeenCalled();
        });
        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
      });
    });
  });

  describe('URL-seeded state (Phase 7C dashboard compatibility)', () => {
    const lowProduct = {
      id: 'low-1',
      name: 'Low Item',
      quantity: 2,
      lowStockThreshold: null,
      lowStockDisabled: false,
      archived: false
    };

    function renderAt(url, productService, extra = null) {
      return render(
        <AppProvider
          services={{ productService, classificationRepository: makeMockClassificationRepository() }}
        >
          <MemoryRouter initialEntries={[url]}>
            {extra}
            <Routes>
              <Route path="/products" element={<ProductListPage />} />
              <Route path="/products/:id" element={<div>Product detail</div>} />
            </Routes>
          </MemoryRouter>
        </AppProvider>
      );
    }

    function serviceReturning(matches = []) {
      return makeMockService({
        searchProducts: vi.fn().mockResolvedValue({ matches, related: [], hasExactMatch: false })
      });
    }

    it('?q= pre-fills the search box and runs that search with the unchanged filter shape', async () => {
      const productService = serviceReturning([{ ...lowProduct, name: 'Parle-G' }]);
      renderAt('/products?q=parle', productService);

      expect(await screen.findByLabelText('Search')).toHaveValue('parle');
      await waitFor(() => {
        expect(productService.searchProducts).toHaveBeenCalledWith('parle', {
          categoryId: null,
          locationIds: [],
          tagIds: []
        });
      });
      expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
    });

    it.each([
      ['low', 'Showing low stock products only.'],
      ['out', 'Showing out-of-stock products only.']
    ])('?stockStatus=%s applies the filter and says so in words', async (status, message) => {
      const productService = serviceReturning([lowProduct]);
      renderAt(`/products?stockStatus=${status}`, productService);

      await waitFor(() => {
        expect(productService.searchProducts).toHaveBeenCalledWith('', {
          categoryId: null,
          locationIds: [],
          tagIds: [],
          stockStatus: status
        });
      });
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(await screen.findByText(/Low Item/)).toBeInTheDocument();
    });

    it('combines ?q= and ?stockStatus=', async () => {
      const productService = serviceReturning([]);
      renderAt('/products?q=parle&stockStatus=out', productService);
      await waitFor(() => {
        expect(productService.searchProducts).toHaveBeenCalledWith('parle', {
          categoryId: null,
          locationIds: [],
          tagIds: [],
          stockStatus: 'out'
        });
      });
    });

    it('ignores an unrecognised stockStatus: normal list, no filter, no indicator', async () => {
      const productService = makeMockService({ listProducts: vi.fn().mockResolvedValue([lowProduct]) });
      renderAt('/products?stockStatus=bogus', productService);

      expect(await screen.findByText(/Low Item/)).toBeInTheDocument();
      expect(productService.searchProducts).not.toHaveBeenCalled();
      expect(screen.queryByText(/showing .* only/i)).not.toBeInTheDocument();
    });

    it('treats an empty ?q= as no search', async () => {
      const productService = makeMockService({ listProducts: vi.fn().mockResolvedValue([lowProduct]) });
      renderAt('/products?q=', productService);
      expect(await screen.findByText(/Low Item/)).toBeInTheDocument();
      expect(productService.searchProducts).not.toHaveBeenCalled();
    });

    it('"Clear filters" removes a URL-seeded stock-status filter and returns to the full list', async () => {
      const productService = makeMockService({
        listProducts: vi.fn().mockResolvedValue([lowProduct, { ...lowProduct, id: 'ok', name: 'Fine Item', quantity: 99 }]),
        searchProducts: vi.fn().mockResolvedValue({ matches: [lowProduct], related: [], hasExactMatch: false })
      });
      renderAt('/products?stockStatus=low', productService);
      await screen.findByText('Showing low stock products only.');

      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

      await waitFor(() => {
        expect(screen.queryByText(/showing .* only/i)).not.toBeInTheDocument();
      });
      expect(await screen.findByText(/Fine Item/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });

    it('re-seeds from the URL when it changes while the page stays mounted', async () => {
      const productService = serviceReturning([]);
      renderAt('/products?stockStatus=low', productService, (
        <Link to="/products?stockStatus=out">go-out</Link>
      ));
      await screen.findByText('Showing low stock products only.');

      fireEvent.click(screen.getByText('go-out'));

      expect(await screen.findByText('Showing out-of-stock products only.')).toBeInTheDocument();
      await waitFor(() => {
        expect(productService.searchProducts).toHaveBeenLastCalledWith('', {
          categoryId: null,
          locationIds: [],
          tagIds: [],
          stockStatus: 'out'
        });
      });
    });

    it('rows reached through a URL-seeded filter still open the product detail page', async () => {
      const productService = serviceReturning([lowProduct]);
      renderAt('/products?stockStatus=low', productService);
      fireEvent.click(await screen.findByText(/Low Item/));
      expect(await screen.findByText('Product detail')).toBeInTheDocument();
    });
  });

  describe('Phase 7D presentation', () => {
    const prod = (id, name, quantity = 50) => ({
      id,
      name,
      quantity,
      lowStockThreshold: null,
      lowStockDisabled: false,
      archived: false
    });

    function Where() {
      const l = useLocation();
      return <div data-testid="where">{l.pathname + l.search}</div>;
    }

    const OPTIONS = {
      category: [{ id: 'cat1', name: 'Snacks' }],
      location: [
        { id: 'loc1', name: 'Counter' },
        { id: 'loc2', name: 'Back Room' }
      ],
      tag: [{ id: 'tag1', name: 'popular' }]
    };
    const optionsRepo = (options = OPTIONS) => ({
      list: vi.fn(async (type) => options[type] ?? [])
    });

    function renderPage(productService, { url = '/products', repo = makeMockClassificationRepository() } = {}) {
      return render(
        <AppProvider services={{ productService, classificationRepository: repo }}>
          <MemoryRouter initialEntries={[url]}>
            <Where />
            <Routes>
              <Route path="/" element={<div>Dashboard screen</div>} />
              <Route path="/products" element={<ProductListPage />} />
              <Route path="/products/new" element={<div>New product screen</div>} />
              <Route path="/products/:id" element={<div>Product detail screen</div>} />
            </Routes>
          </MemoryRouter>
        </AppProvider>
      );
    }

    const rowNames = () =>
      screen.queryAllByRole('listitem').map((li) => li.querySelector('.product-row__name')?.textContent);
    const searchOf = (matches, extra = {}) =>
      vi.fn().mockResolvedValue({ matches, related: [], hasExactMatch: false, ...extra });
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      return { promise, resolve };
    };

    describe('header and navigation', () => {
      it('has a Products heading and an Add Product link to /products/new', async () => {
        renderPage(makeMockService());
        expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeInTheDocument();
        const add = screen.getByRole('link', { name: 'Add Product' });
        expect(add).toHaveAttribute('href', '/products/new');
        fireEvent.click(add);
        expect(await screen.findByText('New product screen')).toBeInTheDocument();
        expect(screen.getByTestId('where').textContent).toBe('/products/new');
      });

      it('rows are real links to /products/:id and open the detail route', async () => {
        renderPage(makeMockService({ listProducts: vi.fn().mockResolvedValue([prod('abc', 'Parle-G')]) }));
        const link = await screen.findByRole('link', { name: /Parle-G/ });
        expect(link).toHaveAttribute('href', '/products/abc');
        fireEvent.click(link);
        expect(await screen.findByText('Product detail screen')).toBeInTheDocument();
      });

      it('search results and related products are also links to their products', async () => {
        const service = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [prod('m1', 'Parle-G')],
            related: [prod('r1', 'Good Day')],
            hasExactMatch: false
          })
        });
        renderPage(service, { url: '/products?q=parleg' });
        expect(await screen.findByRole('link', { name: /Parle-G/ })).toHaveAttribute('href', '/products/m1');
        expect(screen.getByRole('link', { name: /Good Day/ })).toHaveAttribute('href', '/products/r1');
      });
    });

    describe('controls stay available while the list loads or fails', () => {
      it('shows the header, Add Product and search immediately, with a loading state only in the list area', () => {
        renderPage(makeMockService({ listProducts: vi.fn(() => new Promise(() => {})) }));
        expect(screen.getByRole('heading', { name: 'Products' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Add Product' })).toBeInTheDocument();
        expect(screen.getByLabelText('Search')).toBeInTheDocument();
        expect(screen.getByText(/loading products/i)).toBeInTheDocument();
      });

      it('on a failed load: friendly message, the underlying detail, Try again, and a Dashboard link', async () => {
        renderPage(makeMockService({ listProducts: vi.fn().mockRejectedValue(new Error('database unavailable')) }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("Couldn't load your products.");
        expect(screen.getByText('database unavailable')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute('href', '/');
        // header and search are still there
        expect(screen.getByRole('link', { name: 'Add Product' })).toBeInTheDocument();
        expect(screen.getByLabelText('Search')).toBeInTheDocument();
      });

      it('Try again reloads and shows the products; the error and Dashboard link go away', async () => {
        const listProducts = vi
          .fn()
          .mockRejectedValueOnce(new Error('flaky'))
          .mockResolvedValueOnce([prod('p1', 'Parle-G')]);
        renderPage(makeMockService({ listProducts }));

        fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).not.toBeInTheDocument();
        expect(listProducts).toHaveBeenCalledTimes(2);
      });

      it('"Go to Dashboard" navigates to the dashboard', async () => {
        renderPage(makeMockService({ listProducts: vi.fn().mockRejectedValue(new Error('x')) }));
        fireEvent.click(await screen.findByRole('link', { name: 'Go to Dashboard' }));
        expect(await screen.findByText('Dashboard screen')).toBeInTheDocument();
      });

      it('search still works when the plain product list failed to load', async () => {
        const service = makeMockService({
          listProducts: vi.fn().mockRejectedValue(new Error('list down')),
          searchProducts: searchOf([prod('m1', 'Parle-G')], { hasExactMatch: true })
        });
        renderPage(service, { url: '/products?q=parle-g' });

        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
        expect(screen.queryByText('list down')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).not.toBeInTheDocument();
      });
    });

    describe('ordering', () => {
      it('browse list is sorted by name, case-insensitively, unnamed last', async () => {
        renderPage(
          makeMockService({
            listProducts: vi
              .fn()
              .mockResolvedValue([prod('1', 'Zeta'), prod('2', null), prod('3', 'apple'), prod('4', 'Mango')])
          })
        );
        await screen.findByText(/Zeta/);
        expect(rowNames()).toEqual(['apple', 'Mango', 'Zeta', 'Unnamed product']);
      });

      it('filters-only results (no text query) are sorted by name', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([prod('1', 'Zeta'), prod('2', 'Alpha')]) }), {
          url: '/products?stockStatus=low'
        });
        await screen.findByText(/Alpha/);
        expect(rowNames()).toEqual(['Alpha', 'Zeta']);
      });

      it('text-query results keep the search relevance order', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([prod('1', 'Zeta'), prod('2', 'Alpha')]) }), {
          url: '/products?q=ze'
        });
        await screen.findByText(/Alpha/);
        expect(rowNames()).toEqual(['Zeta', 'Alpha']);
      });

      it('related products keep their own order', async () => {
        const service = makeMockService({
          searchProducts: vi.fn().mockResolvedValue({
            matches: [prod('m', 'Match')],
            related: [prod('r1', 'Zulu'), prod('r2', 'Alpha')],
            hasExactMatch: false
          })
        });
        renderPage(service, { url: '/products?q=mat' });
        await screen.findByText(/Zulu/);
        expect(rowNames()).toEqual(['Match', 'Zulu', 'Alpha']);
      });
    });

    describe('search result states', () => {
      it('labels closest matches when a text query has no exact match', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([prod('1', 'Parle-G')]) }), {
          url: '/products?q=parleg'
        });
        expect(await screen.findByRole('heading', { name: 'Closest matches' })).toBeInTheDocument();
        expect(screen.getByText('No exact match for “parleg”.')).toBeInTheDocument();
      });

      it('adds no closest-matches wording for an exact match', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([prod('1', 'Parle-G')], { hasExactMatch: true }) }), {
          url: '/products?q=parle-g'
        });
        await screen.findByText(/Parle-G/);
        expect(screen.queryByRole('heading', { name: 'Closest matches' })).not.toBeInTheDocument();
        expect(screen.queryByText(/no exact match/i)).not.toBeInTheDocument();
      });

      it('adds no closest-matches wording to a filters-only search', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([prod('1', 'Parle-G')]) }), {
          url: '/products?stockStatus=low'
        });
        await screen.findByText(/Parle-G/);
        expect(screen.queryByRole('heading', { name: 'Closest matches' })).not.toBeInTheDocument();
      });

      it('shows only the no-match message (no closest heading) when nothing matches', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([]) }), { url: '/products?q=zzz' });
        expect(await screen.findByText('No products match your search.')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Closest matches' })).not.toBeInTheDocument();
      });

      it('shows a searching state, not a false "no match" flash, while the search is pending', async () => {
        const pending = deferred();
        const service = makeMockService({ searchProducts: vi.fn(() => pending.promise) });
        renderPage(service, { url: '/products?q=parle' });

        expect(screen.getByText(/searching/i)).toBeInTheDocument();
        expect(screen.queryByText('No products match your search.')).not.toBeInTheDocument();

        pending.resolve({ matches: [prod('1', 'Parle-G')], related: [], hasExactMatch: true });
        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
        expect(screen.queryByText(/searching/i)).not.toBeInTheDocument();
      });

      describe('search failure', () => {
        it('shows a friendly message and detail, keeps the query and filters, and Try again re-runs the same search', async () => {
          const searchProducts = vi
            .fn()
            .mockRejectedValueOnce(new Error('index unavailable'))
            .mockResolvedValueOnce({ matches: [prod('1', 'Parle-G')], related: [], hasExactMatch: true });
          renderPage(makeMockService({ searchProducts }), { url: '/products?q=parle&stockStatus=low' });

          const alert = await screen.findByRole('alert');
          expect(alert).toHaveTextContent("Couldn’t run that search. Your search and filters are kept.");
          expect(screen.getByText('index unavailable')).toBeInTheDocument();
          expect(screen.getByLabelText('Search')).toHaveValue('parle');
          expect(screen.getByText('Showing low stock products only.')).toBeInTheDocument();

          fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

          expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
          expect(screen.queryByRole('alert')).not.toBeInTheDocument();
          expect(searchProducts).toHaveBeenCalledTimes(2);
          expect(searchProducts.mock.calls[1]).toEqual(searchProducts.mock.calls[0]);
        });
      });

      it('ignores a stale response that arrives after the search changed', async () => {
        const slow = deferred();
        const searchProducts = vi.fn((query) =>
          query === 'old'
            ? slow.promise
            : Promise.resolve({ matches: [prod('new', 'Fresh Result')], related: [], hasExactMatch: true })
        );
        render(
          <AppProvider
            services={{
              productService: makeMockService({ searchProducts }),
              classificationRepository: makeMockClassificationRepository()
            }}
          >
            <MemoryRouter initialEntries={['/products?q=old']}>
              <Link to="/products?q=new">go-new</Link>
              <Routes>
                <Route path="/products" element={<ProductListPage />} />
              </Routes>
            </MemoryRouter>
          </AppProvider>
        );

        fireEvent.click(screen.getByText('go-new'));
        expect(await screen.findByText(/Fresh Result/)).toBeInTheDocument();

        slow.resolve({ matches: [prod('old', 'Stale Result')], related: [], hasExactMatch: true });
        await waitFor(() => expect(searchProducts).toHaveBeenCalledWith('old', expect.anything()));
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByText(/Stale Result/)).not.toBeInTheDocument();
        expect(screen.getByText(/Fresh Result/)).toBeInTheDocument();
      });
    });

    describe('filter presentation', () => {
      it('renders no filter controls when there are no filter options and no active filter', async () => {
        renderPage(makeMockService());
        await screen.findByText(/no products yet/i);
        expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Locations' })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Tags' })).not.toBeInTheDocument();
      });

      it('renders only the groups that have options', async () => {
        renderPage(makeMockService(), { repo: optionsRepo({ category: OPTIONS.category }) });
        expect(await screen.findByLabelText('Category')).toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Locations' })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Tags' })).not.toBeInTheDocument();
      });

      it('renders locations and tags as labelled groups of native, keyboard-reachable checkboxes', async () => {
        renderPage(makeMockService(), { repo: optionsRepo() });
        const locations = await screen.findByRole('group', { name: 'Locations' });
        const counter = within(locations).getByLabelText('Counter');
        expect(counter).toHaveAttribute('type', 'checkbox');
        expect(counter).not.toBeDisabled();
        expect(counter).not.toHaveAttribute('tabindex', '-1');
        expect(within(screen.getByRole('group', { name: 'Tags' })).getByLabelText('popular')).toBeInTheDocument();
      });

      it('summarizes active filters by count, and Clear filters removes them all', async () => {
        const service = makeMockService({ searchProducts: searchOf([]) });
        renderPage(service, { repo: optionsRepo() });
        await screen.findByLabelText('Category');
        expect(screen.queryByText(/filters? active/i)).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'cat1' } });
        expect(await screen.findByText('1 filter active')).toBeInTheDocument();

        fireEvent.click(screen.getByLabelText('Counter'));
        fireEvent.click(screen.getByLabelText('popular'));
        expect(screen.getByText('3 filters active')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(screen.queryByText(/filters? active/i)).not.toBeInTheDocument();
        expect(screen.getByLabelText('Category')).toHaveValue('');
        expect(screen.getByLabelText('Counter')).not.toBeChecked();
        expect(screen.getByLabelText('popular')).not.toBeChecked();
      });

      it('counts a URL-seeded stock filter together with the others and keeps its sentence', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([]) }), { url: '/products?stockStatus=out', repo: optionsRepo() });
        await screen.findByLabelText('Category');
        fireEvent.click(screen.getByLabelText('Counter'));

        expect(await screen.findByText('2 filters active')).toBeInTheDocument();
        expect(screen.getByText('Showing out-of-stock products only.')).toBeInTheDocument();
      });

      it('still shows the active summary and Clear filters for a stock filter when no filter options exist', async () => {
        renderPage(makeMockService({ searchProducts: searchOf([]) }), { url: '/products?stockStatus=low' });
        expect(await screen.findByText('1 filter active')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
      });

      it('on a filter-options failure: friendly message, no raw error, and browsing still works', async () => {
        const repo = { list: vi.fn().mockRejectedValue(new Error('classification table missing')) };
        renderPage(makeMockService({ listProducts: vi.fn().mockResolvedValue([prod('1', 'Parle-G')]) }), { repo });

        expect(await screen.findByRole('alert')).toHaveTextContent(
          "Couldn’t load your filters. You can still browse and search."
        );
        expect(screen.queryByText('classification table missing')).not.toBeInTheDocument();
        expect(await screen.findByText(/Parle-G/)).toBeInTheDocument();
      });
    });
  });
});
