import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';
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

function DetailStub() {
  const { id } = useParams();
  return <div>Product detail: {id}</div>;
}

function renderAt(productService, path) {
  return render(
    <AppProvider services={{ productService }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/products/new" element={<ProductFormPage />} />
          <Route path="/products/:id/edit" element={<ProductFormPage />} />
          <Route path="/products/:id" element={<DetailStub />} />
          <Route path="/products" element={<div>Product list</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

const renderCreate = (productService) => renderAt(productService, '/products/new');
const renderEdit = (productService, id) => renderAt(productService, `/products/${id}/edit`);

// An existing product service double for edit tests.
function editService(existing, overrides = {}) {
  return makeMockService({
    getProduct: vi.fn().mockResolvedValue(existing),
    updateProduct: vi.fn().mockResolvedValue({ product: existing, errors: [] }),
    ...overrides
  });
}

async function waitForEditForm() {
  await screen.findByRole('heading', { name: 'Edit Product' });
}

const SAVE_FAILED = /couldn.t save this product/i;

describe('ProductFormPage', () => {
  let consoleError;
  beforeEach(() => {
    // Unexpected save failures are logged on purpose; keep test output clean.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  // ===========================================================================
  // Create mode
  // ===========================================================================

  describe('create', () => {
    it('renders create context with empty name and notes fields', () => {
      renderCreate(makeMockService());

      expect(screen.getByRole('heading', { name: 'Add Product' })).toBeInTheDocument();
      expect(screen.queryByText('Edit Product')).not.toBeInTheDocument();
      expect(screen.getByLabelText(/name/i)).toHaveValue('');
      expect(screen.getByLabelText(/notes/i)).toHaveValue('');
      expect(screen.getByRole('group', { name: 'Product details' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('does not call the service until the form is submitted', () => {
      const productService = makeMockService();
      renderCreate(productService);
      expect(productService.getProduct).not.toHaveBeenCalled();
      expect(productService.createProduct).not.toHaveBeenCalled();
    });

    it('submits name and notes and navigates to the new product detail', async () => {
      const productService = makeMockService({
        createProduct: vi.fn().mockResolvedValue({
          product: { id: 'new-id', name: 'Parle-G', notes: 'crunchy' },
          errors: []
        })
      });
      renderCreate(productService);

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Parle-G' } });
      fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'crunchy' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(productService.createProduct).toHaveBeenCalledWith({ name: 'Parle-G', notes: 'crunchy' });
      });
      expect(await screen.findByText('Product detail: new-id')).toBeInTheDocument();
    });

    it('trims the name before creating', async () => {
      const productService = makeMockService({
        createProduct: vi.fn().mockResolvedValue({ product: { id: 'n1' }, errors: [] })
      });
      renderCreate(productService);

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  Parle-G  ' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(productService.createProduct).toHaveBeenCalledWith({ name: 'Parle-G', notes: '' });
      });
    });

    it('shows the domain validation message, linked to the name input, and stays on the form', async () => {
      const productService = makeMockService({
        createProduct: vi.fn().mockResolvedValue({
          product: { name: '' },
          errors: ['Product needs a name or photo.']
        })
      });
      renderCreate(productService);

      fireEvent.click(screen.getByText('Save'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Product needs a name or photo.');

      const nameInput = screen.getByLabelText(/name/i);
      expect(nameInput).toHaveAttribute('aria-invalid', 'true');
      expect(nameInput.getAttribute('aria-describedby')).toContain(alert.id);
      expect(screen.queryByText(/Product detail:/)).not.toBeInTheDocument();
      expect(screen.queryByText('Product list')).not.toBeInTheDocument();
      // Not the save-failure message.
      expect(screen.queryByText(SAVE_FAILED)).not.toBeInTheDocument();
    });

    it('whitespace-only name is sent trimmed and the domain message is shown', async () => {
      const productService = makeMockService({
        createProduct: vi.fn().mockResolvedValue({
          product: { name: '' },
          errors: ['Product needs a name or photo.']
        })
      });
      renderCreate(productService);

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '   ' } });
      fireEvent.click(screen.getByText('Save'));

      await screen.findByRole('alert');
      expect(productService.createProduct).toHaveBeenCalledWith({ name: '', notes: '' });
    });

    it('clears a previous validation error when resubmitting', async () => {
      const createProduct = vi
        .fn()
        .mockResolvedValueOnce({ product: {}, errors: ['Product needs a name or photo.'] })
        .mockResolvedValueOnce({ product: { id: 'n2' }, errors: [] });
      renderCreate(makeMockService({ createProduct }));

      fireEvent.click(screen.getByText('Save'));
      await screen.findByRole('alert');

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Soap' } });
      fireEvent.click(screen.getByText('Save'));

      expect(await screen.findByText('Product detail: n2')).toBeInTheDocument();
    });

    it('shows a friendly save failure, keeps the entered values and resets saving', async () => {
      const productService = makeMockService({
        createProduct: vi.fn().mockRejectedValue(new Error('offline: write failed'))
      });
      renderCreate(productService);

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Parle-G' } });
      fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'crunchy' } });
      fireEvent.click(screen.getByText('Save'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(SAVE_FAILED);
      expect(screen.queryByText(/offline: write failed/)).not.toBeInTheDocument();

      // entered data preserved, form not reset, button usable again
      expect(screen.getByLabelText(/name/i)).toHaveValue('Parle-G');
      expect(screen.getByLabelText(/notes/i)).toHaveValue('crunchy');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByText(/Product detail:/)).not.toBeInTheDocument();
      // not shown as a validation error on the input
      expect(screen.getByLabelText(/name/i)).not.toHaveAttribute('aria-invalid');
      expect(consoleError).toHaveBeenCalled();
    });

    it('disables the button and shows Saving… while the save is in flight', async () => {
      let resolveCreate;
      const productService = makeMockService({
        createProduct: vi.fn().mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)))
      });
      renderCreate(productService);

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Soap' } });
      fireEvent.click(screen.getByText('Save'));

      const busy = await screen.findByRole('button', { name: 'Saving…' });
      expect(busy).toBeDisabled();
      fireEvent.submit(busy.closest('form'));
      expect(productService.createProduct).toHaveBeenCalledTimes(1);

      resolveCreate({ product: { id: 'n3' }, errors: [] });
      expect(await screen.findByText('Product detail: n3')).toBeInTheDocument();
    });

    it('Cancel is a link to the Products list', () => {
      renderCreate(makeMockService());
      const cancel = screen.getByRole('link', { name: 'Cancel' });
      expect(cancel).toHaveAttribute('href', '/products');
      fireEvent.click(cancel);
      expect(screen.getByText('Product list')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Edit mode
  // ===========================================================================

  describe('edit', () => {
    const existing = { id: 'p1', name: 'Good Day', notes: 'buttery', quantity: 5 };

    it('shows a loading state, then the form with existing values and edit context', async () => {
      renderEdit(editService(existing), 'p1');

      expect(screen.getByRole('status')).toHaveTextContent('Loading product…');
      await waitForEditForm();
      expect(screen.queryByText('Add Product')).not.toBeInTheDocument();
      expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day');
      expect(screen.getByLabelText(/notes/i)).toHaveValue('buttery');
    });

    it('loads the product by the route id', async () => {
      const productService = editService(existing);
      renderEdit(productService, 'p1');
      await waitForEditForm();
      expect(productService.getProduct).toHaveBeenCalledWith('p1');
    });

    it('navigates to the same product detail after a successful edit', async () => {
      const productService = editService(existing, {
        updateProduct: vi.fn().mockResolvedValue({ product: { ...existing, name: 'Good Day Deluxe' }, errors: [] })
      });
      renderEdit(productService, 'p1');
      await waitForEditForm();

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Good Day Deluxe' } });
      fireEvent.click(screen.getByText('Save'));

      expect(await screen.findByText('Product detail: p1')).toBeInTheDocument();
    });

    it('shows the domain validation message linked to the name input and stays on the form', async () => {
      const productService = editService(existing, {
        updateProduct: vi.fn().mockResolvedValue({ product: existing, errors: ['Product needs a name or photo.'] })
      });
      renderEdit(productService, 'p1');
      await waitForEditForm();

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '' } });
      fireEvent.click(screen.getByText('Save'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Product needs a name or photo.');
      expect(screen.getByLabelText(/name/i).getAttribute('aria-describedby')).toContain(alert.id);
      expect(screen.getByLabelText(/name/i)).toHaveValue('');
      expect(screen.queryByText(/Product detail:/)).not.toBeInTheDocument();
    });

    it('shows a not-found state when the product does not exist', async () => {
      renderEdit(makeMockService({ getProduct: vi.fn().mockResolvedValue(undefined) }), 'missing-id');

      expect(await screen.findByText(/product not found/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    });

    it('offers a working way back to Products from the not-found state', async () => {
      renderEdit(makeMockService({ getProduct: vi.fn().mockResolvedValue(undefined) }), 'missing-id');

      // the alert keeps exactly the original message
      expect(await screen.findByRole('alert')).toHaveTextContent(/^Product not found\.$/);
      fireEvent.click(screen.getByRole('link', { name: 'Back to Products' }));
      expect(screen.getByText('Product list')).toBeInTheDocument();
    });

    it('shows a friendly load error without the raw message, and Try again recovers', async () => {
      const getProduct = vi
        .fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce(existing);
      renderEdit(makeMockService({ getProduct }), 'p1');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load this product.");
      expect(screen.queryByText(/network unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await waitForEditForm();
      expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day');
      expect(getProduct).toHaveBeenCalledTimes(2);
    });

    it('shows a friendly save failure, keeps the entered values and resets saving', async () => {
      const productService = editService(existing, {
        updateProduct: vi.fn().mockRejectedValue(new Error('productRepository.update() may not modify quantity.'))
      });
      renderEdit(productService, 'p1');
      await waitForEditForm();

      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Good Day Deluxe' } });
      fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'new note' } });
      fireEvent.click(screen.getByText('Save'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(SAVE_FAILED);
      expect(screen.queryByText(/may not modify quantity/)).not.toBeInTheDocument();

      expect(screen.getByLabelText(/name/i)).toHaveValue('Good Day Deluxe');
      expect(screen.getByLabelText(/notes/i)).toHaveValue('new note');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByText(/Product detail:/)).not.toBeInTheDocument();
    });

    it('Cancel is a link back to the same product detail', async () => {
      renderEdit(editService(existing), 'p1');
      await waitForEditForm();

      const cancel = screen.getByRole('link', { name: 'Cancel' });
      expect(cancel).toHaveAttribute('href', '/products/p1');
      fireEvent.click(cancel);
      expect(screen.getByText('Product detail: p1')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Dirty-only patch (edit): the form sends only what changed
  // ===========================================================================

  describe('edit: dirty-only patch', () => {
    const existing = { id: 'p1', name: 'Good Day', notes: 'buttery', quantity: 5 };

    async function submitEdit(product, change) {
      const productService = editService(product);
      renderEdit(productService, product.id);
      await waitForEditForm();
      change();
      fireEvent.click(screen.getByText('Save'));
      return productService;
    }

    it('changing only the name sends only name', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Good Day Deluxe' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(existing, { name: 'Good Day Deluxe' });
    });

    it('changing only the notes sends only notes', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'crispy' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(existing, { notes: 'crispy' });
    });

    it('changing both sends both', async () => {
      const svc = await submitEdit(existing, () => {
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Marie' } });
        fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'plain' } });
      });
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(existing, { name: 'Marie', notes: 'plain' });
    });

    it('submitting unchanged values does not call update and goes to the detail page', async () => {
      const svc = await submitEdit(existing, () => {});
      expect(await screen.findByText('Product detail: p1')).toBeInTheDocument();
      expect(svc.updateProduct).not.toHaveBeenCalled();
      expect(svc.createProduct).not.toHaveBeenCalled();
    });

    it('a photo-only product (null name) saved untouched makes no write', async () => {
      const photoOnly = { id: 'p2', name: null, photoRef: 'photo-1', notes: null, quantity: 0 };
      const svc = await submitEdit(photoOnly, () => {});
      expect(await screen.findByText('Product detail: p2')).toBeInTheDocument();
      expect(svc.updateProduct).not.toHaveBeenCalled();
    });

    it('a photo-only product gaining a name sends only name', async () => {
      const photoOnly = { id: 'p2', name: null, photoRef: 'photo-1', notes: null, quantity: 0 };
      const svc = await submitEdit(photoOnly, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Mystery biscuit' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(photoOnly, { name: 'Mystery biscuit' });
    });

    it('surrounding whitespace in a changed name is trimmed before submission', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  Marie  ' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(existing, { name: 'Marie' });
    });

    it('adding only surrounding whitespace to the name is not a change', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  Good Day ' } })
      );
      expect(await screen.findByText('Product detail: p1')).toBeInTheDocument();
      expect(svc.updateProduct).not.toHaveBeenCalled();
    });

    it('a whitespace-only name on a photo-only product is not a change', async () => {
      const photoOnly = { id: 'p2', name: null, photoRef: 'photo-1', notes: null, quantity: 0 };
      const svc = await submitEdit(photoOnly, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '   ' } })
      );
      expect(await screen.findByText('Product detail: p2')).toBeInTheDocument();
      expect(svc.updateProduct).not.toHaveBeenCalled();
    });

    it('a missing note and an empty note are the same (no notes change)', async () => {
      const noNotes = { id: 'p3', name: 'Soap', notes: null, quantity: 1 };
      const svc = await submitEdit(noNotes, () => {});
      expect(await screen.findByText('Product detail: p3')).toBeInTheDocument();
      expect(svc.updateProduct).not.toHaveBeenCalled();
    });

    it('clearing existing notes sends an empty notes value', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: '' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      expect(svc.updateProduct).toHaveBeenCalledWith(existing, { notes: '' });
    });

    it('never sends quantity or other fields, and passes the loaded snapshot', async () => {
      const svc = await submitEdit(existing, () =>
        fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'X' } })
      );
      await waitFor(() => expect(svc.updateProduct).toHaveBeenCalledTimes(1));
      const [snapshot, patch] = svc.updateProduct.mock.calls[0];
      expect(snapshot).toBe(existing);
      expect(Object.keys(patch)).toEqual(['name']);
    });
  });
});
