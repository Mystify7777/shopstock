import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProductRow from './ProductRow.jsx';

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderRow(product) {
  return render(
    <MemoryRouter initialEntries={['/products']}>
      <Where />
      <Routes>
        <Route path="/products" element={<ul><ProductRow product={product} /></ul>} />
        <Route path="/products/:id" element={<div>detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const base = {
  id: 'p1',
  name: 'Parle-G',
  quantity: 50,
  lowStockThreshold: null,
  lowStockDisabled: false,
  unitId: 'unit-kg'
};

describe('ProductRow', () => {
  it('is a single list item containing one real link to the product', () => {
    renderRow(base);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/products/p1');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('navigates to the product detail route when clicked', () => {
    renderRow(base);
    fireEvent.click(screen.getByRole('link'));
    expect(screen.getByTestId('where')).toHaveTextContent('/products/p1');
  });

  it('shows the name and quantity inside the link', () => {
    renderRow({ ...base, quantity: 2.5 });
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('Parle-G');
    expect(link).toHaveTextContent('2.5');
  });

  it.each([null, undefined, ''])('falls back to "Unnamed product" for a photo-only product (name %j)', (name) => {
    renderRow({ ...base, name });
    expect(screen.getByRole('link')).toHaveTextContent('Unnamed product');
  });

  it('does not show a unit (only unitId is available on the product, and no lookup is added)', () => {
    renderRow(base);
    expect(screen.getByRole('link')).not.toHaveTextContent(/unit-kg/);
  });

  describe('stock status label (text, never color alone)', () => {
    it('labels a healthy product "In stock" with no status role', () => {
      renderRow({ ...base, quantity: 50 });
      expect(screen.getByText('In stock')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('labels a low-stock product with role="status" and the domain status text', () => {
      renderRow({ ...base, quantity: 3 });
      expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
      expect(screen.queryByText('In stock')).not.toBeInTheDocument();
    });

    it('treats quantity equal to the threshold as low (inclusive, per the domain)', () => {
      renderRow({ ...base, quantity: 5 });
      expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
    });

    it('labels a zero-quantity product Out of Stock', () => {
      renderRow({ ...base, quantity: 0 });
      expect(screen.getByRole('status')).toHaveTextContent('Out of Stock');
    });

    it('honors a per-product threshold override', () => {
      renderRow({ ...base, quantity: 8, lowStockThreshold: 10 });
      expect(screen.getByRole('status')).toHaveTextContent('Low Stock');
    });

    it('never flags Low when low-stock warnings are disabled, but zero is still Out', () => {
      const { unmount } = renderRow({ ...base, quantity: 2, lowStockDisabled: true });
      expect(screen.getByText('In stock')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();

      renderRow({ ...base, quantity: 0, lowStockDisabled: true });
      expect(screen.getByRole('status')).toHaveTextContent('Out of Stock');
    });

    it('puts the status inside the link so it is part of the row\'s accessible name', () => {
      renderRow({ ...base, quantity: 0 });
      expect(screen.getByRole('link', { name: /Parle-G.*Out of Stock/ })).toBeInTheDocument();
    });
  });

  it('hides the decorative chevron from assistive technology', () => {
    const { container } = renderRow(base);
    expect(container.querySelector('.product-row__chevron')).toHaveAttribute('aria-hidden', 'true');
  });
});
