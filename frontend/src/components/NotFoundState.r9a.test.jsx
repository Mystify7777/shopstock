// Redesign R9a: the not-found message is a NEUTRAL notice (a missing thing is
// not a system failure) and the way out is a quiet link. The message text, the
// single role="alert", and the link's destination are pinned by
// NotFoundState.test.jsx, which passes unmodified.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotFoundState from './NotFoundState.jsx';
import NotFoundPage from '../pages/NotFoundPage.jsx';

const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';
function renderState(props = {}) {
  return render(
    <MemoryRouter>
      <NotFoundState message="We couldn't find that product." linkTo="/products" linkLabel="Back to Products" {...props} />
    </MemoryRouter>
  );
}

describe('the message is a neutral notice', () => {
  it('is the one alert, a notice.notice--neutral, never a danger notice', () => {
    renderState();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveClass('notice', 'notice--neutral');
    expect(alerts[0]).not.toHaveClass('notice--danger');
    expect(alerts[0]).toHaveTextContent("We couldn't find that product.");
    expect(alerts[0].tagName).toBe('P');
  });

  it('the link sits outside the alert, so only the problem is announced', () => {
    renderState();
    const alert = screen.getByRole('alert');
    const link = screen.getByRole('link', { name: 'Back to Products' });
    expect(alert).not.toContainElement(link);
    expect(alert.querySelectorAll(INTERACTIVE)).toHaveLength(0);
  });
});

describe('the way out is a quiet link', () => {
  it('is a plain link to the given destination with the 44px target class and the quiet look, and nothing else', () => {
    renderState({ linkTo: '/products', linkLabel: 'Back to Products' });
    const link = screen.getByRole('link', { name: 'Back to Products' });
    expect(link).toHaveAttribute('href', '/products');
    expect(link).toHaveClass('touch-link', 'quiet-link');
    expect(link).not.toHaveClass('primary-action-link');
    expect(link.querySelector(INTERACTIVE)).toBeNull();
    expect(document.querySelectorAll(INTERACTIVE)).toHaveLength(1);
  });
});

describe('the router fallback page', () => {
  it('keeps its heading and uses the same neutral message and quiet link', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('notice', 'notice--neutral');
    expect(screen.getByRole('link')).toHaveClass('touch-link', 'quiet-link');
  });
});
