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

    it('labels a low-stock product with the domain status text, as plain text and not a live region', () => {
      renderRow({ ...base, quantity: 3 });
      const label = screen.getByText('Low Stock');
      expect(label).not.toHaveAttribute('role');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByText('In stock')).not.toBeInTheDocument();
    });

    it('treats quantity equal to the threshold as low (inclusive, per the domain)', () => {
      renderRow({ ...base, quantity: 5 });
      expect(screen.getByText('Low Stock')).toBeInTheDocument();
    });

    it('labels a zero-quantity product Out of Stock', () => {
      renderRow({ ...base, quantity: 0 });
      expect(screen.getByText('Out of Stock')).toBeInTheDocument();
    });

    it('honors a per-product threshold override', () => {
      renderRow({ ...base, quantity: 8, lowStockThreshold: 10 });
      expect(screen.getByText('Low Stock')).toBeInTheDocument();
    });

    it('never flags Low when low-stock warnings are disabled, but zero is still Out', () => {
      const { unmount } = renderRow({ ...base, quantity: 2, lowStockDisabled: true });
      expect(screen.getByText('In stock')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();

      renderRow({ ...base, quantity: 0, lowStockDisabled: true });
      expect(screen.getByText('Out of Stock')).toBeInTheDocument();
    });

    it('puts the status inside the link so it is part of the row\'s accessible name', () => {
      renderRow({ ...base, quantity: 0 });
      expect(screen.getByRole('link', { name: /Parle-G.*Out of Stock/ })).toBeInTheDocument();
    });

    // A stock level is a state, not an event, so no row announces itself. A
    // live region per row (nested in a link) would be noise for a whole list.
    it('a list of low and out-of-stock rows contains no live regions at all', () => {
      render(
        <MemoryRouter>
          <ul>
            <ProductRow product={{ ...base, id: 'a', quantity: 0 }} />
            <ProductRow product={{ ...base, id: 'b', quantity: 2 }} />
            <ProductRow product={{ ...base, id: 'c', quantity: 1 }} />
          </ul>
        </MemoryRouter>
      );
      expect(screen.getAllByText(/Out of Stock|Low Stock/)).toHaveLength(3);
      expect(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    });
  });

  // Phase 7I: a long name is cut with a CSS ellipsis, never by character count,
  // so the full name stays in the DOM and in the link's accessible name.
  it('truncates a long name with the shared ellipsis class but keeps the full name accessible', () => {
    const longName = 'Extra Long Name Premium Imported Whole Grain Basmati Rice Family Pack 25 kg Value Edition';
    const { container } = renderRow({ ...base, name: longName });
    const name = container.querySelector('.product-row__name');
    expect(name).toHaveClass('text-truncate');
    expect(name.textContent).toBe(longName);
    expect(screen.getByRole('link', { name: new RegExp(longName) })).toHaveAttribute('href', '/products/p1');
  });

  it('hides the decorative chevron from assistive technology', () => {
    const { container } = renderRow(base);
    expect(container.querySelector('.product-row__chevron')).toHaveAttribute('aria-hidden', 'true');
  });

  // Redesign R3: shared badge, quantity emphasis, no nested controls.
  describe('R3: shared status badge and quantity', () => {
    it.each([
      [50, 'In stock', 'badge--ok'],
      [3, 'Low Stock', 'badge--low'],
      [0, 'Out of Stock', 'badge--out']
    ])('quantity %s renders "%s" as the shared %s badge (and keeps the legacy hook)', (quantity, text, modifier) => {
      renderRow({ ...base, quantity });
      const badge = screen.getByText(text);
      expect(badge).toHaveClass('badge', modifier, 'product-row__status');
      // Exactly one badge variant, so two status systems cannot both apply.
      expect(badge.className.match(/badge--/g)).toHaveLength(1);
    });

    it('the badge is plain text: no role, no tabindex, not a control', () => {
      renderRow({ ...base, quantity: 0 });
      const badge = screen.getByText('Out of Stock');
      expect(badge.tagName).toBe('SPAN');
      expect(badge).not.toHaveAttribute('role');
      expect(badge).not.toHaveAttribute('tabindex');
    });

    it('the quantity is its own element, so it can carry the dominant styling', () => {
      const { container } = renderRow({ ...base, quantity: 2.5 });
      const quantity = container.querySelector('.product-row__quantity');
      expect(quantity).toHaveTextContent(/^2\.5$/);
      expect(screen.getByRole('link')).toContainElement(quantity);
    });

    it('order in the link is name, quantity, status, then the decorative chevron', () => {
      const { container } = renderRow({ ...base, quantity: 3 });
      const classes = [...container.querySelector('.product-row__link').children].map((el) => el.className);
      expect(classes[0]).toMatch(/product-row__name/);
      expect(classes[1]).toMatch(/product-row__quantity/);
      expect(classes[2]).toMatch(/product-row__status/);
      expect(classes[3]).toMatch(/product-row__chevron/);
    });

    it('contains no nested interactive element: the link is the only control', () => {
      const { container } = renderRow({ ...base, quantity: 0 });
      const link = screen.getByRole('link');
      expect(link.querySelectorAll('a, button, input, select, textarea, summary, [tabindex], [role]')).toHaveLength(0);
      expect(container.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(1);
    });

    it('a long name stays whole in the DOM, truncated by CSS, while quantity and status still render', () => {
      const longName = 'Extra Long Name Premium Imported Whole Grain Basmati Rice Family Pack 25 kg Value Edition';
      const { container } = renderRow({ ...base, name: longName, quantity: 1250.75 });
      expect(container.querySelector('.product-row__name')).toHaveClass('text-truncate');
      expect(container.querySelector('.product-row__name').textContent).toBe(longName);
      expect(container.querySelector('.product-row__quantity')).toHaveTextContent('1250.75');
      expect(screen.getByText('In stock')).toHaveClass('badge');
    });
  });
});
