import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotFoundState from './NotFoundState.jsx';

describe('NotFoundState', () => {
  it('announces the message and offers a way back, as a touch-target link outside the alert', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <NotFoundState message="Product not found." linkTo="/products" linkLabel="Back to Products" />
      </MemoryRouter>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Product not found.');
    const link = screen.getByRole('link', { name: 'Back to Products' });
    expect(link).toHaveAttribute('href', '/products');
    expect(link).toHaveClass('touch-link'); // 7H Slice 3: 44px target
    expect(alert).not.toContainElement(link); // only the message is announced
  });
});
