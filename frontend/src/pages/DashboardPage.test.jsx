import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import DashboardPage from './DashboardPage.jsx';
import ProductListPage from './ProductListPage.jsx';

// Page behavior only. The derivations (summarizeInventory, toActivityEntry)
// have their own tests; services are stubbed at the AppContext boundary.
// Navigation INTO the real ProductListPage is exercised end to end at the
// bottom of this file.

let n = 0;
function product(overrides = {}) {
  n += 1;
  return {
    id: `p${n}`,
    name: `Product ${n}`,
    quantity: 20,
    sellingPrice: null,
    lowStockThreshold: null,
    lowStockDisabled: false,
    archived: false,
    ...overrides
  };
}

function event(overrides = {}) {
  n += 1;
  return {
    id: `e${n}`,
    productId: 'p-x',
    type: 'ADD',
    quantity: 5,
    appliedQuantity: 5,
    recordedAt: '2026-09-01T10:00:00.000Z',
    reversalOf: null,
    ...overrides
  };
}

function makeServices({ products = [], events = [], productsError, eventsError } = {}) {
  const productService = {
    listProducts: vi.fn(async (options = {}) => {
      if (productsError) throw productsError;
      return options.includeArchived ? products : products.filter((p) => !p.archived);
    }),
    searchProducts: vi.fn().mockResolvedValue({ matches: [], related: [], hasExactMatch: false })
  };
  const stockEventService = {
    getRecentActivity: vi.fn(async () => {
      if (eventsError) throw eventsError;
      return events;
    })
  };
  return { productService, stockEventService };
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderDashboard(services, { listPage = false } = {}) {
  return render(
    <AppProvider
      services={{
        ...services,
        classificationRepository: { list: vi.fn().mockResolvedValue([]) }
      }}
    >
      <MemoryRouter initialEntries={['/']}>
        <LocationDisplay />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={listPage ? <ProductListPage /> : <div>Products screen</div>} />
          <Route path="/products/new" element={<div>New product screen</div>} />
          <Route path="/products/:id" element={<div>Product detail screen</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

const section = (name) => screen.getByRole('region', { name });
const never = () => new Promise(() => {});

describe('DashboardPage', () => {
  it('renders the heading, an Add Product link, and a search form without waiting for data', () => {
    const services = makeServices();
    services.productService.listProducts = vi.fn(never);
    services.stockEventService.getRecentActivity = vi.fn(never);
    renderDashboard(services);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add Product' })).toHaveAttribute('href', '/products/new');
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByLabelText('Search products')).toBeInTheDocument();
  });

  describe('loading', () => {
    it('shows a loading state in each data section independently', () => {
      const services = makeServices();
      services.productService.listProducts = vi.fn(never);
      services.stockEventService.getRecentActivity = vi.fn(never);
      renderDashboard(services);

      expect(within(section('Inventory')).getByRole('status')).toHaveTextContent('Loading inventory');
      expect(within(section('Needs attention')).getByRole('status')).toHaveTextContent('Checking stock levels');
      expect(within(section('Recently updated')).getByRole('status')).toHaveTextContent('Loading recent activity');
    });
  });

  describe('empty states', () => {
    it('shows friendly empty messages when there is no data', async () => {
      renderDashboard(makeServices());

      expect(await screen.findByText('No products yet. Add your first product to get started.')).toBeInTheDocument();
      expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
      expect(await screen.findByText('No stock activity yet.')).toBeInTheDocument();
      // no misleading zeros or value when there is nothing to count
      expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
      expect(screen.queryByText('Expected selling value')).not.toBeInTheDocument();
    });
  });

  describe('inventory summary', () => {
    it('shows active product, low-stock and out-of-stock counts (archived excluded)', async () => {
      renderDashboard(
        makeServices({
          products: [
            product({ quantity: 50 }),
            product({ quantity: 50 }),
            product({ quantity: 2 }),
            product({ quantity: 0 }),
            product({ quantity: 0, archived: true }),
            product({ quantity: 1, archived: true })
          ]
        })
      );

      const inventory = section('Inventory');
      await within(inventory).findByText('Products');
      const stat = (label) => within(inventory).getByText(label).closest('div');
      expect(within(stat('Products')).getByText('4')).toBeInTheDocument();
      expect(within(stat('Low stock')).getByText('1')).toBeInTheDocument();
      expect(within(stat('Out of stock')).getByText('1')).toBeInTheDocument();
    });

    it('shows expected selling value only from priced products, and says how many were left out', async () => {
      renderDashboard(
        makeServices({
          products: [
            product({ quantity: 10, sellingPrice: 100 }),
            product({ quantity: 2.5, sellingPrice: 100 }),
            product({ quantity: 7, sellingPrice: null }),
            product({ quantity: 3, sellingPrice: null })
          ]
        })
      );

      const inventory = section('Inventory');
      expect(await within(inventory).findByText('1,250.00')).toBeInTheDocument();
      expect(within(inventory).getByText('Expected selling value')).toBeInTheDocument();
      expect(within(inventory).getByText(/2 products have no selling price and are not included/i)).toBeInTheDocument();
    });

    it('uses singular wording for exactly one unpriced product', async () => {
      renderDashboard(
        makeServices({ products: [product({ sellingPrice: 10 }), product({ sellingPrice: null })] })
      );
      expect(await screen.findByText(/1 product has no selling price and is not included/i)).toBeInTheDocument();
    });

    it('omits the value (and the note) when no product has a price', async () => {
      renderDashboard(makeServices({ products: [product(), product()] }));
      await screen.findByText('Products');
      expect(screen.queryByText('Expected selling value')).not.toBeInTheDocument();
      expect(screen.queryByText(/no selling price/i)).not.toBeInTheDocument();
    });

    it('omits the note when every product is priced', async () => {
      renderDashboard(makeServices({ products: [product({ sellingPrice: 10 })] }));
      await screen.findByText('Expected selling value');
      expect(screen.queryByText(/no selling price/i)).not.toBeInTheDocument();
    });

    it('never shows cost, profit or a total-units figure', async () => {
      renderDashboard(makeServices({ products: [product({ sellingPrice: 10 })] }));
      await screen.findByText('Products');
      expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/profit/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/total units/i)).not.toBeInTheDocument();
    });
  });

  describe('needs attention', () => {
    it('groups out-of-stock and low-stock products with text status and links to each product', async () => {
      const out = product({ name: 'Dettol', quantity: 0 });
      const low = product({ name: 'Parle-G', quantity: 3 });
      renderDashboard(makeServices({ products: [out, low, product({ quantity: 99 })] }));

      const attention = section('Needs attention');
      expect(await within(attention).findByRole('heading', { name: 'Out of stock (1)' })).toBeInTheDocument();
      expect(within(attention).getByRole('heading', { name: 'Low stock (1)' })).toBeInTheDocument();

      expect(within(attention).getByRole('link', { name: 'Dettol' })).toHaveAttribute('href', `/products/${out.id}`);
      expect(within(attention).getByRole('link', { name: 'Parle-G' })).toHaveAttribute('href', `/products/${low.id}`);
      // status is conveyed in words, not by color
      expect(within(attention).getByText('Out of stock', { selector: 'span' })).toBeInTheDocument();
      expect(within(attention).getByText('Low stock (3 left)')).toBeInTheDocument();
    });

    it('links each group to the matching filtered Product List', async () => {
      renderDashboard(makeServices({ products: [product({ quantity: 0 }), product({ quantity: 1 }), product({ quantity: 2 })] }));
      const attention = section('Needs attention');
      expect(await within(attention).findByRole('link', { name: 'View all 1 in Products' })).toHaveAttribute(
        'href',
        '/products?stockStatus=out'
      );
      expect(within(attention).getByRole('link', { name: 'View all 2 in Products' })).toHaveAttribute(
        'href',
        '/products?stockStatus=low'
      );
    });

    it('omits a group with no members', async () => {
      renderDashboard(makeServices({ products: [product({ quantity: 0 })] }));
      const attention = section('Needs attention');
      await within(attention).findByRole('heading', { name: 'Out of stock (1)' });
      expect(within(attention).queryByRole('heading', { name: /Low stock/ })).not.toBeInTheDocument();
    });

    it('lists at most five rows per group but reports the full count', async () => {
      const outs = Array.from({ length: 7 }, (_, i) => product({ name: `Out ${i}`, quantity: 0 }));
      renderDashboard(makeServices({ products: outs }));
      const attention = section('Needs attention');
      await within(attention).findByRole('heading', { name: 'Out of stock (7)' });
      expect(within(attention).getAllByRole('listitem')).toHaveLength(5);
      expect(within(attention).getByRole('link', { name: 'View all 7 in Products' })).toBeInTheDocument();
    });
  });

  describe('recently updated (recent stock activity, PRD §29)', () => {
    it('asks for the ten most recent events', async () => {
      const services = makeServices();
      renderDashboard(services);
      await screen.findByText('No stock activity yet.');
      expect(services.stockEventService.getRecentActivity).toHaveBeenCalledWith(10);
    });

    it('shows product, direction, amount and time, linking to the product', async () => {
      const dettol = product({ name: 'Dettol' });
      renderDashboard(
        makeServices({
          products: [dettol],
          events: [event({ productId: dettol.id, type: 'ADD', quantity: 20, appliedQuantity: 20 })]
        })
      );

      const activity = section('Recently updated');
      const link = await within(activity).findByRole('link', { name: 'Dettol' });
      expect(link).toHaveAttribute('href', `/products/${dettol.id}`);
      expect(within(activity).getByText(/Added 20/)).toBeInTheDocument();
      const time = activity.querySelector('time');
      expect(time).toHaveAttribute('datetime', '2026-09-01T10:00:00.000Z');
    });

    it('shows a clamped over-removal by what actually applied', async () => {
      const p = product({ name: 'Parle-G' });
      renderDashboard(
        makeServices({
          products: [p],
          events: [event({ productId: p.id, type: 'REMOVE', quantity: 8, appliedQuantity: 5 })]
        })
      );
      expect(await screen.findByText(/Removed 5/)).toBeInTheDocument();
      expect(screen.queryByText(/Removed 8/)).not.toBeInTheDocument();
    });

    it('labels reversals', async () => {
      const p = product({ name: 'Good Day' });
      renderDashboard(
        makeServices({
          products: [p],
          events: [event({ productId: p.id, type: 'REMOVE', quantity: 3, appliedQuantity: 3, reversalOf: 'e-orig' })]
        })
      );
      expect(await screen.findByText(/Removed 3 \(reversal\)/)).toBeInTheDocument();
    });

    it('resolves the name of a product that has since been archived', async () => {
      const archived = product({ name: 'Old Stock', archived: true });
      renderDashboard(makeServices({ products: [archived], events: [event({ productId: archived.id })] }));
      expect(await screen.findByRole('link', { name: 'Old Stock' })).toBeInTheDocument();
    });

    it('falls back to a plain label for an unknown product, still linking to it', async () => {
      renderDashboard(makeServices({ events: [event({ productId: 'ghost' })] }));
      expect(await screen.findByRole('link', { name: 'Unknown product' })).toHaveAttribute('href', '/products/ghost');
    });
  });

  describe('error and retry', () => {
    it('a failing inventory load shows errors there, but does not blank recent activity', async () => {
      const p = product({ name: 'Dettol' });
      const services = makeServices({ products: [p], events: [event({ productId: p.id })] });
      // Fail ONLY the inventory read (active products); the activity
      // section's own name lookup (includeArchived) keeps working.
      services.productService.listProducts = vi.fn(async (options = {}) => {
        if (!options.includeArchived) throw new Error('inventory read failed');
        return [p];
      });
      renderDashboard(services);

      // inventory and attention share that one load and both say so
      expect(await within(section('Inventory')).findByRole('alert')).toHaveTextContent("Couldn't load your inventory.");
      expect(within(section('Needs attention')).getByRole('alert')).toHaveTextContent("Couldn't check your stock levels.");
      // recent activity is untouched
      const activity = section('Recently updated');
      expect(await within(activity).findByRole('link', { name: 'Dettol' })).toBeInTheDocument();
      expect(within(activity).queryByRole('alert')).not.toBeInTheDocument();
      // unrelated controls still work
      expect(screen.getByRole('link', { name: 'Add Product' })).toBeInTheDocument();
      expect(screen.getByRole('search')).toBeInTheDocument();
    });

    it('a failing activity load leaves the inventory summary intact', async () => {
      renderDashboard(
        makeServices({
          products: [product({ quantity: 0 }), product({ quantity: 30 })],
          eventsError: new Error('events unavailable')
        })
      );

      expect(await within(section('Recently updated')).findByRole('alert')).toHaveTextContent(
        "Couldn't load recent activity."
      );
      const inventory = section('Inventory');
      expect(await within(inventory).findByText('Products')).toBeInTheDocument();
      expect(within(section('Needs attention')).getByRole('heading', { name: 'Out of stock (1)' })).toBeInTheDocument();
      expect(within(inventory).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('retry reloads the failed section and shows its content when it succeeds', async () => {
      const services = makeServices();
      let inventoryAttempts = 0;
      services.productService.listProducts = vi.fn(async (options = {}) => {
        if (options.includeArchived) return [];
        inventoryAttempts += 1;
        if (inventoryAttempts === 1) throw new Error('flaky');
        return [product({ quantity: 0 })];
      });
      renderDashboard(services);

      const inventory = section('Inventory');
      fireEvent.click(await within(inventory).findByRole('button', { name: 'Try again' }));

      expect(await within(inventory).findByText('Products')).toBeInTheDocument();
      expect(within(inventory).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('retrying a failed activity section does not reload the inventory', async () => {
      const services = makeServices({ products: [product()] });
      services.stockEventService.getRecentActivity = vi
        .fn()
        .mockRejectedValueOnce(new Error('flaky'))
        .mockResolvedValueOnce([]);
      renderDashboard(services);

      const activity = section('Recently updated');
      const retry = await within(activity).findByRole('button', { name: 'Try again' });
      await within(section('Inventory')).findByText('Products');
      const inventoryLoads = services.productService.listProducts.mock.calls.filter(
        ([options]) => !options?.includeArchived
      ).length;

      fireEvent.click(retry);

      expect(await within(activity).findByText('No stock activity yet.')).toBeInTheDocument();
      expect(
        services.productService.listProducts.mock.calls.filter(([options]) => !options?.includeArchived).length
      ).toBe(inventoryLoads);
    });
  });

  describe('search navigation', () => {
    it('navigates to the product list with the (trimmed, encoded) query in the URL', () => {
      renderDashboard(makeServices());
      fireEvent.change(screen.getByLabelText('Search products'), { target: { value: '  parle g  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      expect(screen.getByTestId('location')).toHaveTextContent('/products?q=parle%20g');
    });

    it('goes to the plain product list when the search box is empty', () => {
      renderDashboard(makeServices());
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      expect(screen.getByTestId('location').textContent).toBe('/products');
    });

    it('submits on Enter (form submit)', () => {
      renderDashboard(makeServices());
      const input = screen.getByLabelText('Search products');
      fireEvent.change(input, { target: { value: 'dettol' } });
      fireEvent.submit(input.closest('form'));
      expect(screen.getByTestId('location')).toHaveTextContent('/products?q=dettol');
    });
  });

  describe('other navigation', () => {
    it('Add Product opens the new-product screen', () => {
      renderDashboard(makeServices());
      fireEvent.click(screen.getByRole('link', { name: 'Add Product' }));
      expect(screen.getByText('New product screen')).toBeInTheDocument();
    });

    it('a recent-activity row opens that product', async () => {
      const p = product({ name: 'Dettol' });
      renderDashboard(makeServices({ products: [p], events: [event({ productId: p.id })] }));
      fireEvent.click(await screen.findByRole('link', { name: 'Dettol' }));
      expect(screen.getByText('Product detail screen')).toBeInTheDocument();
      expect(screen.getByTestId('location').textContent).toBe(`/products/${p.id}`);
    });
  });

  describe('reaching the real Product List through the URL', () => {
    it('search lands on the list with that query applied', async () => {
      const services = makeServices({ products: [product({ name: 'Parle-G' })] });
      renderDashboard(services, { listPage: true });

      fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'parle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      expect(await screen.findByLabelText('Search')).toHaveValue('parle');
      await waitFor(() => {
        expect(services.productService.searchProducts).toHaveBeenCalledWith('parle', {
          categoryId: null,
          locationIds: [],
          tagIds: []
        });
      });
    });

    it.each([
      ['out', 'Out of stock (1)', 'Showing out-of-stock products only.'],
      ['low', 'Low stock (1)', 'Showing low stock products only.']
    ])('the "%s" group lands on the list with that stock filter applied', async (status, heading, message) => {
      const services = makeServices({ products: [product({ quantity: 0 }), product({ quantity: 2 })] });
      renderDashboard(services, { listPage: true });

      const attention = section('Needs attention');
      await within(attention).findByRole('heading', { name: heading });
      fireEvent.click(attention.querySelector(`a[href="/products?stockStatus=${status}"]`));

      expect(await screen.findByText(message)).toBeInTheDocument();
      await waitFor(() => {
        expect(services.productService.searchProducts).toHaveBeenCalledWith('', {
          categoryId: null,
          locationIds: [],
          tagIds: [],
          stockStatus: status
        });
      });
    });
  });
});
