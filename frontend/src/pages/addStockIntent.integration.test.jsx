import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import DashboardPage from './DashboardPage.jsx';
import ProductDetailPage from './ProductDetailPage.jsx';
import { ADD_STOCK_INTENT } from '../navigation/addStockIntent.js';

// Issue #56, end to end across the REAL dashboard and product pages: a row's
// "Add stock" link arrives on that product's page with the existing Add Stock
// form open and focus in Quantity. Services are stubbed at the AppContext
// boundary only; the pages, router and focus handling are real.

const OUT = { id: 'p-out', name: 'Dettol', quantity: 0, lowStockThreshold: null, lowStockDisabled: false, archived: false, sellingPrice: null };
const LOW = { id: 'p-low', name: 'Parle-G', quantity: 3, lowStockThreshold: null, lowStockDisabled: false, archived: false, sellingPrice: null };
const PRODUCTS = [OUT, LOW];

function makeServices({ getProduct, addStock } = {}) {
  const productService = {
    listProducts: vi.fn(async () => PRODUCTS),
    searchProducts: vi.fn().mockResolvedValue({ matches: [], related: [], hasExactMatch: false }),
    getProduct: getProduct ?? vi.fn(async (id) => PRODUCTS.find((p) => p.id === id) ?? null)
  };
  const stockEventService = {
    getRecentActivity: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue([]),
    getLatestKnownCost: vi.fn().mockResolvedValue(null),
    wouldOverRemove: vi.fn().mockResolvedValue(false),
    addStock: addStock ?? vi.fn().mockResolvedValue({ event: { id: 'new-event', appliedQuantity: 3 }, errors: [] }),
    removeStock: vi.fn(),
    reverseEvent: vi.fn()
  };
  return { productService, stockEventService };
}

// Shows where we are and what navigation state this entry carries.
function LocationProbe() {
  const location = useLocation();
  return (
    <div
      data-testid="loc"
      data-path={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
      data-state={JSON.stringify(location.state)}
    />
  );
}

function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>history back</button>;
}

function renderApp(services, { entries = ['/'], strict = false } = {}) {
  const tree = (
    <AppProvider services={{ ...services, classificationRepository: { list: vi.fn().mockResolvedValue([]) } }}>
      <MemoryRouter initialEntries={entries}>
        <LocationProbe />
        <BackButton />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route
            path="/products"
            element={
              <div>
                Product list <Link to="/products/p-low">ordinary link to Parle-G</Link>
              </div>
            }
          />
          <Route path="/products/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const loc = () => screen.getByTestId('loc');
const addStockRow = (name) => screen.findByRole('link', { name: `Add stock for ${name}` });
const addButton = () => screen.getByRole('button', { name: 'Add Stock' });

describe('Add stock from a dashboard row (#56)', () => {
  it('opens the Add Stock form for the SAME product whose row was used, not another one', async () => {
    const services = makeServices();
    renderApp(services);

    fireEvent.click(await addStockRow('Parle-G')); // the SECOND row

    expect(await screen.findByRole('heading', { name: 'Parle-G' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Quantity')).toBeInTheDocument();
    expect(addButton()).toHaveAttribute('aria-expanded', 'true');
    expect(services.productService.getProduct).toHaveBeenCalledWith('p-low');
    expect(services.productService.getProduct).not.toHaveBeenCalledWith('p-out');
  });

  it('the other row opens its own product (context is per row)', async () => {
    renderApp(makeServices());
    fireEvent.click(await addStockRow('Dettol'));
    expect(await screen.findByRole('heading', { name: 'Dettol' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Quantity')).toBeInTheDocument();
  });

  it('puts focus in Quantity once the form has rendered', async () => {
    renderApp(makeServices());
    fireEvent.click(await addStockRow('Parle-G'));
    const quantity = await screen.findByLabelText('Quantity');
    await waitFor(() => expect(quantity).toHaveFocus());
  });

  it('adds no query string or hash, and consumes the router state with a replace', async () => {
    renderApp(makeServices());
    fireEvent.click(await addStockRow('Parle-G'));
    await screen.findByLabelText('Quantity');

    await waitFor(() => expect(loc().dataset.state).toBe('null')); // intent cleared
    expect(loc().dataset.path).toBe('/products/p-low');
    expect(loc().dataset.search).toBe('');
    expect(loc().dataset.hash).toBe('');
  });

  it('does not reopen after Back/Forward to the consumed entry', async () => {
    renderApp(makeServices());
    fireEvent.click(await addStockRow('Parle-G'));
    await screen.findByLabelText('Quantity');
    await waitFor(() => expect(loc().dataset.state).toBe('null'));

    fireEvent.click(screen.getByRole('link', { name: /Products/ })); // ‹ Products back link
    expect(await screen.findByText(/Product list/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('history back')); // back to /products/p-low (state already cleared)

    expect(await screen.findByRole('heading', { name: 'Parle-G' })).toBeInTheDocument();
    expect(addButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  });

  it('under React Strict Mode the intent is consumed once: one open, one cost lookup', async () => {
    const services = makeServices();
    renderApp(services, { strict: true });
    fireEvent.click(await addStockRow('Parle-G'));
    await screen.findByLabelText('Quantity');
    await waitFor(() => expect(loc().dataset.state).toBe('null'));

    // openAddForm looks up the latest cost exactly once per open; a second
    // (double-fired) open would call it twice.
    expect(services.stockEventService.getLatestKnownCost).toHaveBeenCalledTimes(1);
    expect(services.stockEventService.getLatestKnownCost).toHaveBeenCalledWith('p-low');
    expect(screen.getAllByLabelText('Quantity')).toHaveLength(1);
    expect(addButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('waits for the product to load before consuming the intent, then opens and clears it', async () => {
    let resolveProduct;
    const getProduct = vi.fn(() => new Promise((resolve) => (resolveProduct = resolve)));
    renderApp(makeServices({ getProduct }), { entries: [{ pathname: '/products/p-low', state: ADD_STOCK_INTENT }] });

    expect(await screen.findByText('Loading product…')).toBeInTheDocument();
    expect(loc().dataset.state).toBe(JSON.stringify(ADD_STOCK_INTENT)); // not consumed while loading
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();

    resolveProduct(LOW);
    expect(await screen.findByLabelText('Quantity')).toBeInTheDocument();
    await waitFor(() => expect(loc().dataset.state).toBe('null'));
  });

  it('a missing product shows Product not found, opens no form, and still clears the intent', async () => {
    const services = makeServices({ getProduct: vi.fn().mockResolvedValue(null) });
    renderApp(services, { entries: [{ pathname: '/products/nope', state: ADD_STOCK_INTENT }] });

    expect(await screen.findByRole('alert')).toHaveTextContent(/^Product not found\.$/);
    await waitFor(() => expect(loc().dataset.state).toBe('null'));
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(services.stockEventService.getLatestKnownCost).not.toHaveBeenCalled();
  });

  it('a load failure opens no form and clears the intent, leaving the normal retry', async () => {
    const getProduct = vi.fn().mockRejectedValue(new Error('IDB boom'));
    renderApp(makeServices({ getProduct }), { entries: [{ pathname: '/products/p-low', state: ADD_STOCK_INTENT }] });

    expect(await screen.findByText("Couldn't load this product.")).toBeInTheDocument();
    await waitFor(() => expect(loc().dataset.state).toBe('null'));
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });

  it('an ordinary product link (the name, or any plain link) arrives with the form closed', async () => {
    renderApp(makeServices());
    fireEvent.click(await screen.findByRole('link', { name: 'Parle-G' })); // the name link: no intent
    expect(await screen.findByRole('heading', { name: 'Parle-G' })).toBeInTheDocument();
    expect(loc().dataset.state).toBe('null'); // router state is null when none was passed
    expect(addButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  });

  it('ignores unrelated router state', async () => {
    renderApp(makeServices(), { entries: [{ pathname: '/products/p-low', state: { openAddStock: 'yes', other: 1 } }] });
    expect(await screen.findByRole('heading', { name: 'Parle-G' })).toBeInTheDocument();
    expect(addButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  });

  it('changes no stock until Save, and Save goes through the existing addStock with that product', async () => {
    const services = makeServices();
    renderApp(services);
    fireEvent.click(await addStockRow('Parle-G'));
    const quantity = await screen.findByLabelText('Quantity');

    // Arriving, opening and focusing changed nothing.
    expect(services.stockEventService.addStock).not.toHaveBeenCalled();
    expect(services.stockEventService.removeStock).not.toHaveBeenCalled();
    expect(services.stockEventService.reverseEvent).not.toHaveBeenCalled();

    fireEvent.change(quantity, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(services.stockEventService.addStock).toHaveBeenCalledTimes(1));
    expect(services.stockEventService.addStock).toHaveBeenCalledWith(expect.objectContaining({ productId: 'p-low', quantity: 3 }));
    expect(await screen.findByText(/Stock increased by 3/)).toBeInTheDocument(); // the existing undo notice
  });

  it('keyboard: the action link and the Quantity field are reachable and in order (name, action, then the form)', async () => {
    renderApp(makeServices());
    const action = await addStockRow('Parle-G');
    const name = screen.getByRole('link', { name: 'Parle-G' });
    expect(name.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    action.focus();
    expect(action).toHaveFocus();
    // Links activate with Enter natively; a click is what the browser dispatches for it.
    fireEvent.click(action);
    const quantity = await screen.findByLabelText('Quantity');
    await waitFor(() => expect(quantity).toHaveFocus());
    // Keyboard users can leave: Cost per unit follows Quantity in the form.
    const form = quantity.closest('form');
    expect(within(form).getByLabelText(/Cost per unit/i)).toBeInTheDocument();
  });
});
