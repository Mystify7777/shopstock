import { describe, it, expect, vi, afterEach } from 'vitest';
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
});
