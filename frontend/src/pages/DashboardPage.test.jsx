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
    expect(screen.getByRole('link', { name: 'Add Product' })).toHaveClass('primary-action-link');
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

  // Phase 7H Slice 3. jsdom cannot measure layout, so these pin that every
  // standalone link carries the shared touch-target class; the CSS contract
  // behind that class is asserted in styles/touchTargets.test.js, and the real
  // rendered sizes were measured in a browser, not here.
  describe('touch targets', () => {
    it('Add Product is a touch-target link', () => {
      renderDashboard(makeServices());
      expect(screen.getByRole('link', { name: 'Add Product' })).toHaveClass('touch-link');
    });

    it('needs-attention product links and "View all" links are touch-target links', async () => {
      renderDashboard(makeServices({ products: [product({ name: 'Dettol', quantity: 0 }), product({ name: 'Parle-G', quantity: 3 })] }));
      const attention = section('Needs attention');
      await within(attention).findByRole('link', { name: 'Dettol' });
      // per group: the name link, the "Add stock" action, then "View all"
      const links = within(attention).getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual([
        'Dettol',
        'Add stock for Dettol',
        'View all 1 in Products',
        'Parle-G',
        'Add stock for Parle-G',
        'View all 1 in Products'
      ]);
      for (const link of links) expect(link).toHaveClass('touch-link');
    });

    it('recent-activity product links are touch-target links', async () => {
      const dettol = product({ name: 'Dettol' });
      renderDashboard(makeServices({ products: [dettol], events: [event({ productId: dettol.id, type: 'ADD', quantity: 20, appliedQuantity: 20 })] }));
      expect(await within(section('Recently updated')).findByRole('link', { name: 'Dettol' })).toHaveClass('touch-link');
    });

    it('the recent-activity row still reads "Product: Added N time" (the larger link did not change the text)', async () => {
      const dettol = product({ name: 'Dettol' });
      renderDashboard(makeServices({ products: [dettol], events: [event({ productId: dettol.id, type: 'ADD', quantity: 20, appliedQuantity: 20 })] }));
      const row = (await within(section('Recently updated')).findByRole('link', { name: 'Dettol' })).closest('li');
      expect(row.textContent).toMatch(/^Dettol: Added 20 /);
    });
  });

  // Phase 7I: long names are truncated by CSS only; every attention row has the
  // same shape (name link, then its status in its own non-wrapping span).
  describe('long product names (7I)', () => {
    const longName = 'Extra Long Name Premium Imported Whole Grain Basmati Rice Family Pack 25 kg Value Edition';

    it('an attention row keeps the full name accessible, truncates it by class, and keeps status separate', async () => {
      const out = product({ name: longName, quantity: 0 });
      const low = product({ name: 'Parle-G', quantity: 3 });
      renderDashboard(makeServices({ products: [out, low] }));

      const attention = section('Needs attention');
      const link = await within(attention).findByRole('link', { name: longName });
      expect(link).toHaveClass('touch-link');
      expect(link.querySelector('.text-truncate')?.textContent).toBe(longName);

      // Same two-line shape for a long and a short name: the name link, then a
      // line holding the status (non-wrapping) and the Add stock action.
      const rows = within(attention).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toHaveClass('dashboard__row', 'dashboard__row--stacked');
        expect(row.children).toHaveLength(2);
        expect(row.children[0].tagName).toBe('A');
        const line = row.children[1];
        expect(line).toHaveClass('dashboard__row-line');
        expect(line.children).toHaveLength(2);
        expect(line.children[0]).toHaveClass('dashboard__row-detail--nowrap');
        expect(line.children[1].tagName).toBe('A');
      }
      expect(rows[0].children[1].children[0]).toHaveTextContent('Out of stock');
      expect(rows[1].children[1].children[0]).toHaveTextContent('Low stock (3 left)');
    });

    it('a recent-activity row keeps the full name accessible and truncates it by class', async () => {
      const item = product({ name: longName });
      renderDashboard(makeServices({ products: [item], events: [event({ productId: item.id, type: 'ADD', quantity: 20, appliedQuantity: 20 })] }));
      const link = await within(section('Recently updated')).findByRole('link', { name: longName });
      expect(link.querySelector('.text-truncate')?.textContent).toBe(longName);
      expect(link.closest('li').textContent.startsWith(longName + ': Added 20 ')).toBe(true);
    });

    it('every activity row is two lines: the name link, then a meta line with a hidden colon and a decorative separator', async () => {
      const short = product({ name: 'Dettol' });
      const long = product({ name: longName });
      renderDashboard(
        makeServices({
          products: [short, long],
          events: [
            event({ productId: short.id, type: 'ADD', quantity: 20, appliedQuantity: 20 }),
            event({ productId: long.id, type: 'REMOVE', quantity: 3, appliedQuantity: 3 })
          ]
        })
      );
      const activity = section('Recently updated');
      await within(activity).findByRole('link', { name: 'Dettol' });
      const rows = within(activity).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toHaveClass('dashboard__row--stacked');
        expect(row.children).toHaveLength(2);
        expect(row.children[0].tagName).toBe('A');
        const meta = row.children[1];
        expect(meta).toHaveClass('dashboard__row-meta');
        // The colon is for assistive technology only; the separator is decorative.
        expect(meta.querySelector('.visually-hidden')?.textContent).toBe(': ');
        expect(meta.querySelector('[aria-hidden="true"]')?.textContent.trim()).toBe('·');
        expect(meta.querySelector('time')).not.toBeNull();
      }
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

  // Issue #56: a contextual "Add stock" action on each attention row. It only
  // NAVIGATES to the product page (with a one-shot router-state intent, tested
  // against the real product page in addStockIntent.integration.test.jsx); it
  // never changes stock from the dashboard.
  describe('contextual Add stock action (#56)', () => {
    const longName = 'Extra Long Name Premium Imported Whole Grain Basmati Rice Family Pack 25 kg Value Edition';

    function servicesWithStockSpies(data) {
      const services = makeServices(data);
      services.stockEventService.addStock = vi.fn();
      services.stockEventService.removeStock = vi.fn();
      services.stockEventService.reverseEvent = vi.fn();
      return services;
    }

    it('shows one Add stock link per out-of-stock and low-stock row, for that product, with a unique accessible name', async () => {
      const out = product({ name: 'Dettol', quantity: 0 });
      const low = product({ name: longName, quantity: 3 });
      const fine = product({ name: 'Plenty', quantity: 50 });
      renderDashboard(makeServices({ products: [out, low, fine] }));

      const attention = section('Needs attention');
      const actions = await within(attention).findAllByRole('link', { name: /^Add stock for / });
      expect(actions.map((a) => a.getAttribute('href'))).toEqual([`/products/${out.id}`, `/products/${low.id}`]);
      // Unique names, the full product name even when it is long, visible text still "Add stock".
      expect(actions.map((a) => a.textContent)).toEqual(['Add stock for Dettol', `Add stock for ${longName}`]);
      for (const action of actions) {
        expect(action.textContent.startsWith('Add stock')).toBe(true);
        expect(action.firstChild.textContent.trim()).toBe('Add stock'); // the visible part
        expect(action.querySelector('.visually-hidden')).not.toBeNull();
        expect(action).toHaveClass('touch-link');
      }
      // A product that needs no attention gets no row at all, so no action.
      expect(screen.queryByRole('link', { name: 'Add stock for Plenty' })).not.toBeInTheDocument();
    });

    it('the action is a sibling of the name link: no link inside a link, and no button inside either', async () => {
      renderDashboard(makeServices({ products: [product({ name: 'Dettol', quantity: 0 })] }));
      const attention = section('Needs attention');
      const name = await within(attention).findByRole('link', { name: 'Dettol' });
      const action = within(attention).getByRole('link', { name: 'Add stock for Dettol' });
      expect(name.contains(action)).toBe(false);
      expect(action.contains(name)).toBe(false);
      for (const link of [name, action]) {
        expect(link.querySelector('a, button')).toBeNull();
        expect(link.closest('a, button')).toBe(link);
      }
    });

    it('keeps a logical tab order: each name link, then its action, then the next row', async () => {
      renderDashboard(
        makeServices({ products: [product({ name: 'First', quantity: 0 }), product({ name: 'Second', quantity: 0 })] })
      );
      const attention = section('Needs attention');
      await within(attention).findByRole('link', { name: 'First' });
      const order = within(attention)
        .getAllByRole('link')
        .map((link) => link.textContent);
      expect(order.slice(0, 4)).toEqual(['First', 'Add stock for First', 'Second', 'Add stock for Second']);
      // All are natively focusable: real anchors with an href, no tabindex tricks.
      for (const link of within(attention).getAllByRole('link')) {
        expect(link).toHaveAttribute('href');
        expect(link).not.toHaveAttribute('tabindex');
      }
    });

    it('activity rows get no Add stock action', async () => {
      const dettol = product({ name: 'Dettol', quantity: 50 });
      renderDashboard(
        makeServices({ products: [dettol], events: [event({ productId: dettol.id, type: 'ADD', quantity: 20, appliedQuantity: 20 })] })
      );
      const activity = section('Recently updated');
      await within(activity).findByRole('link', { name: 'Dettol' });
      expect(within(activity).queryByRole('link', { name: /Add stock/ })).not.toBeInTheDocument();
    });

    it('clicking it only navigates to the product page, with no query string, and calls no stock service', async () => {
      const low = product({ name: 'Dettol', quantity: 0 });
      const services = servicesWithStockSpies({ products: [low] });
      renderDashboard(services);

      fireEvent.click(await within(section('Needs attention')).findByRole('link', { name: 'Add stock for Dettol' }));

      expect(await screen.findByText('Product detail screen')).toBeInTheDocument();
      expect(screen.getByTestId('location')).toHaveTextContent(new RegExp(`^/products/${low.id}$`)); // no ?query
      expect(services.stockEventService.addStock).not.toHaveBeenCalled();
      expect(services.stockEventService.removeStock).not.toHaveBeenCalled();
      expect(services.stockEventService.reverseEvent).not.toHaveBeenCalled();
    });

    it('rendering the dashboard calls no stock-mutating service either', async () => {
      const services = servicesWithStockSpies({ products: [product({ name: 'Dettol', quantity: 0 })] });
      renderDashboard(services);
      await within(section('Needs attention')).findByRole('link', { name: 'Add stock for Dettol' });
      expect(services.stockEventService.addStock).not.toHaveBeenCalled();
      expect(services.stockEventService.removeStock).not.toHaveBeenCalled();
      expect(services.stockEventService.reverseEvent).not.toHaveBeenCalled();
    });
  });
});
