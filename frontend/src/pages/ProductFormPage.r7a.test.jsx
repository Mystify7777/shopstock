// Redesign R7a: the product form's errors are the shared danger notice, its
// fieldset/legend grouping and ARIA wiring are intact, and its actions are one
// primary Save plus a quiet Cancel link. Validation, saving, the unchanged-save
// path and Cancel's destinations are pinned by ProductFormPage.test.jsx, which
// passes unmodified. The Product Detail page's own forms (R6, frozen) keep their
// .form-errors block; that is checked here too, from the other side.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductFormPage from './ProductFormPage.jsx';
import ProductDetailPage from './ProductDetailPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';

const EXISTING = { id: 'p1', name: 'Parle-G', notes: 'Orange pack', quantity: 5 };
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

function renderForm(productService, path = '/products/new') {
  return render(
    <AppProvider services={{ productService }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/products/new" element={<ProductFormPage />} />
          <Route path="/products/:id/edit" element={<ProductFormPage />} />
          <Route path="/products/:id" element={<div>Product detail</div>} />
          <Route path="/products" element={<div>Product list</div>} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}
const service = (over = {}) => ({
  listProducts: vi.fn(),
  getProduct: vi.fn().mockResolvedValue(EXISTING),
  createProduct: vi.fn().mockResolvedValue({ errors: ['Product needs a name or photo.'] }),
  updateProduct: vi.fn().mockResolvedValue({ product: EXISTING, errors: [] }),
  ...over
});
const submitEmpty = async (svc = service()) => {
  renderForm(svc);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  return { svc, alert: await screen.findByRole('alert') };
};

describe('form errors are the shared danger notice', () => {
  it('a validation error is a notice.notice--danger alert with its list, and not a .form-errors block', async () => {
    const { alert } = await submitEmpty();
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveAttribute('id', 'product-form-errors');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.tagName).toBe('DIV');
    expect(within(alert).getByRole('listitem')).toHaveTextContent('Product needs a name or photo.');
    expect(document.querySelector('.form-errors')).toBeNull();
  });

  it('several errors are several list items, in order', async () => {
    const { alert } = await submitEmpty(service({ createProduct: vi.fn().mockResolvedValue({ errors: ['One.', 'Two.'] }) }));
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['One.', 'Two.']);
  });

  it('keeps the wiring: the Name input is invalid and described by the help text and the alert', async () => {
    const { alert } = await submitEmpty();
    const name = screen.getByLabelText('Name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name.getAttribute('aria-describedby').split(' ')).toEqual(['product-name-help', alert.id]);
    const notes = screen.getByLabelText('Notes (optional)');
    expect(notes).not.toHaveAttribute('aria-invalid');
    expect(notes.getAttribute('aria-describedby')).toBe('product-notes-help');
  });

  it('a save failure is the same notice (a paragraph alert), described by the Save button, with the values kept', async () => {
    const restore = captureConsoleError('Saving the product failed.');
    const svc = service({ createProduct: vi.fn().mockRejectedValue(new Error('disk full')) });
    renderForm(svc);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Parle-G' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveAttribute('id', 'product-form-save-error');
    expect(alert.tagName).toBe('P');
    expect(alert).toHaveTextContent(/couldn.t save this product/i);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-describedby', 'product-form-save-error');
    expect(screen.getByLabelText('Name')).toHaveValue('Parle-G');
    expect(document.querySelector('.form-errors')).toBeNull();
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe('the product detail page keeps its own .form-errors (R6, frozen)', () => {
  it('its Add Stock validation error is still a .form-errors block, not a notice', async () => {
    const productService = { listProducts: vi.fn(), getProduct: vi.fn().mockResolvedValue({ id: 'p1', name: 'Parle-G', quantity: 10 }) };
    const stockEventService = {
      getHistory: vi.fn().mockResolvedValue([]),
      getLatestKnownCost: vi.fn().mockResolvedValue(null),
      wouldOverRemove: vi.fn().mockResolvedValue(false),
      addStock: vi.fn().mockResolvedValue({ event: null, errors: ['Quantity must be greater than 0.'] })
    };
    render(
      <AppProvider services={{ productService, stockEventService }}>
        <MemoryRouter initialEntries={['/products/p1']}>
          <Routes>
            <Route path="/products/:id" element={<ProductDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add Stock' }));
    fireEvent.change(await screen.findByLabelText('Quantity'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('id', 'add-form-errors');
    expect(alert).toHaveClass('form-errors');
    expect(alert).not.toHaveClass('notice');
  });
});

describe('fieldset and legend semantics survive the visual change', () => {
  it('Product details is a real fieldset with a legend as its first child, holding both fields', async () => {
    renderForm(service());
    const group = screen.getByRole('group', { name: 'Product details' });
    expect(group.tagName).toBe('FIELDSET');
    expect(group.firstElementChild.tagName).toBe('LEGEND');
    expect(group.firstElementChild).toHaveTextContent('Product details');
    expect(within(group).getByLabelText('Name')).toBeInTheDocument();
    expect(within(group).getByLabelText('Notes (optional)')).toBeInTheDocument();
  });

  it('shows only the fields the product has today: a name and notes, nothing for future fields', () => {
    renderForm(service());
    const form = document.querySelector('form');
    expect(form.querySelectorAll('input, textarea, select')).toHaveLength(2);
    expect(form.querySelector('input[type="text"]')).toHaveAttribute('id', 'product-name');
    expect(form.querySelector('textarea')).toHaveAttribute('id', 'product-notes');
  });

  it('every control keeps its label and its help text', () => {
    renderForm(service());
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-describedby', 'product-name-help');
    expect(document.getElementById('product-name-help')).toHaveTextContent('The name you’ll look for when searching.');
    expect(document.getElementById('product-notes-help')).toHaveTextContent('Anything worth remembering about this product.');
  });
});

describe('actions: one primary Save, a quiet Cancel link', () => {
  it('Save is the only primary action and a submit button; Cancel is the only other control and is a link', () => {
    renderForm(service());
    const actions = document.querySelector('.product-form__actions');
    const save = within(actions).getByRole('button', { name: 'Save' });
    expect(save).toHaveClass('primary-action');
    expect(save).toHaveAttribute('type', 'submit');
    expect(document.querySelectorAll('.primary-action')).toHaveLength(1);
    expect(actions.querySelectorAll(INTERACTIVE)).toHaveLength(2);
    const cancel = within(actions).getByRole('link', { name: 'Cancel' });
    expect(cancel).toHaveClass('product-form__cancel');
    expect(cancel.querySelector(INTERACTIVE)).toBeNull();
  });

  it('Cancel goes to the list when adding', () => {
    renderForm(service());
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/products');
  });

  it('Cancel goes back to the product when editing', async () => {
    renderForm(service(), '/products/p1/edit');
    await screen.findByRole('heading', { name: 'Edit Product' });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/products/p1'));
  });
});
