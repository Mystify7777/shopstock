import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import ProductDetailPage from './ProductDetailPage.jsx';
import { ADD_STOCK_INTENT } from '../navigation/addStockIntent.js';

// The one-shot guard on the product page, tested on its own.
//
// In the real app the replace-navigation clears the intent, so the guard is a
// second line of defence: it must hold even if the SAME location (same key,
// intent still present) is seen again. To prove that, the router's navigate is
// replaced by a spy that does NOT clear the state, and the product is then
// reloaded (which hands the effect a new product object, re-running it) by
// saving stock. Without the guard the form would re-open after the save.

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigateSpy
}));

describe('Add stock intent: one-shot guard', () => {
  it('does not re-open the form when the same location is processed again (product reload after a save)', async () => {
    navigateSpy.mockClear();
    const productService = {
      getProduct: vi.fn(async () => ({ id: 'p1', name: 'Parle-G', quantity: 3, lowStockThreshold: null, lowStockDisabled: false }))
    };
    const stockEventService = {
      getHistory: vi.fn().mockResolvedValue([]),
      getLatestKnownCost: vi.fn().mockResolvedValue(null),
      wouldOverRemove: vi.fn().mockResolvedValue(false),
      addStock: vi.fn().mockResolvedValue({ event: { id: 'e1', appliedQuantity: 2 }, errors: [] }),
      removeStock: vi.fn(),
      reverseEvent: vi.fn()
    };
    render(
      <AppProvider services={{ productService, stockEventService }}>
        <MemoryRouter initialEntries={[{ pathname: '/products/p1', state: ADD_STOCK_INTENT }]}>
          <Routes>
            <Route path="/products/:id" element={<ProductDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>
    );

    const quantity = await screen.findByLabelText('Quantity');
    expect(stockEventService.getLatestKnownCost).toHaveBeenCalledTimes(1);

    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Stock increased by 2/)).toBeInTheDocument();
    // The save reloaded the product (a second getProduct call, a new object).
    await waitFor(() => expect(productService.getProduct).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('button', { name: 'Add Stock' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(stockEventService.getLatestKnownCost).toHaveBeenCalledTimes(1); // never opened a second time
    // And it asked the router to clear the intent exactly once, as a replace.
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(
      { pathname: '/products/p1', search: '', hash: '' },
      { replace: true, state: null }
    );
  });
});
