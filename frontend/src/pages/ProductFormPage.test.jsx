import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductFormPage from './ProductFormPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

// productService is mocked here -- the real service -> repository -> Dexie
// path is already covered by src/services/productService.test.js.

function makeMockService(overrides = {}) {
  return {
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    ...overrides
  };
}

function renderCreate(productService) {
  return render(
    <AppProvider services={{ productService }}>
      <MemoryRouter initialEntries={['/products/new']}>
        <Routes>
          <Route path="/products/new" element={<ProductFormPage />} />
          <Route path="/products" element={<div>Product list</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

function renderEdit(productService, id) {
  return render(
    <AppProvider services={{ productService }}>
      <MemoryRouter initialEntries={[`/products/${id}/edit`]}>
        <Routes>
          <Route path="/products/:id/edit" element={<ProductFormPage />} />
          <Route path="/products" element={<div>Product list</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

describe('ProductFormPage', () => {
  // ===========================================================================
  // Create mode
  // ===========================================================================

  it('renders empty name and notes fields in create mode', () => {
    const productService = makeMockService();
    renderCreate(productService);

    expect(screen.getByText('Add Product')).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue('');
    expect(screen.getByLabelText(/notes/i)).toHaveValue('');
  });

  it('submits name and notes and navigates to the list on valid creation', async () => {
    const productService = makeMockService({
      createProduct: vi.fn().mockResolvedValue({
        product: { id: 'new-id', name: 'Parle-G', notes: 'crunchy' },
        errors: []
      })
    });
    renderCreate(productService);

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'Parle-G' }
    });
    fireEvent.change(screen.getByLabelText(/notes/i), {
      target: { value: 'crunchy' }
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(productService.createProduct).toHaveBeenCalledWith({
        name: 'Parle-G',
        notes: 'crunchy'
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Product list')).toBeInTheDocument();
    });
  });

  it('renders validation errors and does not navigate away on failure', async () => {
    const productService = makeMockService({
      createProduct: vi.fn().mockResolvedValue({
        product: { name: '' },
        errors: ['Product needs a name or photo.']
      })
    });
    renderCreate(productService);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Product needs a name or photo.')).toBeInTheDocument();
    });

    // Still on the form, not navigated to the list
    expect(screen.queryByText('Product list')).not.toBeInTheDocument();
  });

  // ===========================================================================
  // Edit mode
  // ===========================================================================

  it('loads and displays the existing product in edit mode', async () => {
    const productService = makeMockService({
      getProduct: vi.fn().mockResolvedValue({
        id: 'p1', name: 'Good Day', notes: 'buttery', quantity: 5
      })
    });
    renderEdit(productService, 'p1');

    await waitFor(() => {
      expect(screen.getByText('Edit Product')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day');
    expect(screen.getByLabelText(/notes/i)).toHaveValue('buttery');
  });

  it('submits the edited fields via updateProduct and navigates to the list', async () => {
    const existing = { id: 'p1', name: 'Good Day', notes: 'buttery', quantity: 5 };
    const productService = makeMockService({
      getProduct: vi.fn().mockResolvedValue(existing),
      updateProduct: vi.fn().mockResolvedValue({
        product: { ...existing, name: 'Good Day Deluxe' },
        errors: []
      })
    });
    renderEdit(productService, 'p1');

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day');
    });

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'Good Day Deluxe' }
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(productService.updateProduct).toHaveBeenCalledWith(
        existing,
        { name: 'Good Day Deluxe', notes: 'buttery' }
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Product list')).toBeInTheDocument();
    });
  });

  it('shows a not-found state when the product does not exist', async () => {
    const productService = makeMockService({
      getProduct: vi.fn().mockResolvedValue(undefined),
    });
    renderEdit(productService, 'missing-id');

    await waitFor(() => {
      expect(screen.getByText(/product not found/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it('shows an error state when loading the product rejects', async () => {
    const productService = makeMockService({
      getProduct: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });
    renderEdit(productService, 'p1');

    await waitFor(() => {
      expect(screen.getByText('network unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it('shows an error state and resets saving when createProduct rejects', async () => {
    const productService = makeMockService({
      createProduct: vi.fn().mockRejectedValue(new Error('offline: write failed')),
    });
    renderCreate(productService);

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'Parle-G' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('offline: write failed')).toBeInTheDocument();
    });

    // saving must be reset -- button usable again, not stuck on "Saving…"
    expect(screen.getByText('Save')).not.toBeDisabled();
    // did not navigate away
    expect(screen.queryByText('Product list')).not.toBeInTheDocument();
  });

  it('shows an error state and resets saving when updateProduct rejects', async () => {
    const existing = { id: 'p1', name: 'Good Day', notes: 'buttery', quantity: 5 };
    const productService = makeMockService({
      getProduct: vi.fn().mockResolvedValue(existing),
      updateProduct: vi.fn().mockRejectedValue(new Error('sync conflict')),
    });
    renderEdit(productService, 'p1');

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day');
    });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('sync conflict')).toBeInTheDocument();
    });

    expect(screen.getByText('Save')).not.toBeDisabled();
    expect(screen.queryByText('Product list')).not.toBeInTheDocument();
  });
});
