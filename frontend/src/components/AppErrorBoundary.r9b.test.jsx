// Redesign R9b: the crash fallback is a flat card with Reload as the one primary
// action and a quiet way out. Behavior (the fallback itself, the copy, heading
// focus, reload, the sanitized log, error-type normalization) is pinned by
// AppErrorBoundary.test.jsx, which passes unmodified.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AppErrorBoundary from './AppErrorBoundary.jsx';

function Bomb() {
  throw new Error('secret product data: Parle-G');
}

const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function crash() {
  return render(
    <AppErrorBoundary>
      <Bomb />
    </AppErrorBoundary>
  );
}

describe('the crash fallback actions', () => {
  it('Reload is the one primary action', () => {
    crash();
    const reload = screen.getByRole('button', { name: 'Reload ShopStock' });
    expect(reload).toHaveClass('primary-action');
    expect(reload).toHaveAttribute('type', 'button');
    expect(document.querySelectorAll('.primary-action')).toHaveLength(1);
  });

  it('Go to Dashboard is a plain quiet link to "/" with the 44px target class, and not primary', () => {
    crash();
    const home = screen.getByRole('link', { name: 'Go to Dashboard' });
    expect(home).toHaveAttribute('href', '/');
    expect(home).toHaveClass('touch-link', 'quiet-link');
    expect(home).not.toHaveClass('primary-action', 'primary-action-link');
    expect(home).not.toHaveClass('app-error__home');
    expect(home.querySelector(INTERACTIVE)).toBeNull();
  });

  it('Reload and the link are the only controls, and the heading is the only other focus target', () => {
    crash();
    const main = screen.getByRole('main');
    expect([...main.querySelectorAll(INTERACTIVE)].map((el) => el.tagName)).toEqual(['H1', 'BUTTON', 'A']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('keeps the card structure the stylesheet targets, and nothing else announces', () => {
    const { container } = crash();
    expect(container.querySelector('main.app-error > .app-error__card > .app-error__actions')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
