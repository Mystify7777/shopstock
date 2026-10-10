import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AppErrorBoundary, { safeErrorType } from './AppErrorBoundary.jsx';

function Bomb({ message = 'secret product data: Parle-G' }) {
  throw new Error(message);
}

let consoleError;
beforeEach(() => {
  // React logs caught render errors itself; keep test output readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  vi.restoreAllMocks();
});

describe('AppErrorBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <AppErrorBoundary>
        <p>All good</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('replaces a crashed tree with a recoverable fallback (never a blank screen)', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText(/Part of ShopStock stopped working/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload ShopStock' })).toBeInTheDocument();
    const home = screen.getByRole('link', { name: 'Go to Dashboard' });
    expect(home).toHaveAttribute('href', '/');
  });

  it('does not promise that unfinished work survives', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    expect(screen.getByText(/may be lost/)).toBeInTheDocument();
    expect(screen.queryByText(/safe|saved automatically|nothing was lost/i)).not.toBeInTheDocument();
  });

  it('never shows the raw error message to the user', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    expect(screen.queryByText(/secret product data/)).not.toBeInTheDocument();
  });

  it('moves focus to the heading so assistive technology announces the failure', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toHaveFocus();
  });

  it('Reload reloads the page', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload ShopStock' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('logs sanitized diagnostics only: the error type and component stack, never the message', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>
    );
    const ours = consoleError.mock.calls.find(([first]) => first === 'ShopStock UI failure:');
    expect(ours).toBeDefined();
    expect(ours[1]).toBe('Error');
    expect(typeof ours[2]).toBe('string');
    expect(JSON.stringify(ours)).not.toContain('secret product data');
  });

  describe('error type normalization (error.name is attacker/author controlled text)', () => {
    class CustomError extends Error {}

    it.each(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError'])(
      'keeps the built-in type %s',
      (name) => {
        const error = new Error('x');
        error.name = name;
        expect(safeErrorType(error)).toBe(name);
      }
    );

    it('real built-in errors keep their type', () => {
      expect(safeErrorType(new TypeError('x'))).toBe('TypeError');
      expect(safeErrorType(new RangeError('x'))).toBe('RangeError');
    });

    it('a name that carries arbitrary content is reduced to "Error"', () => {
      const error = new Error('x');
      error.name = 'ValidationError: product Parle-G has no price';
      expect(safeErrorType(error)).toBe('Error');
    });

    it('an unknown but harmless custom type is reported as plain "Error"', () => {
      const error = new CustomError('x');
      error.name = 'CustomError';
      expect(safeErrorType(error)).toBe('Error');
    });

    it.each([
      ['a non-string name', { name: 42 }],
      ['an object name', { name: { secret: 1 } }],
      ['a missing name', {}],
      ['a thrown string', 'Parle-G exploded'],
      ['null', null],
      ['undefined', undefined]
    ])('%s -> "Error"', (_label, thrown) => {
      expect(safeErrorType(thrown)).toBe('Error');
    });

    it('the boundary logs the normalized type, never a custom name', () => {
      function Hostile() {
        const error = new Error('hidden');
        error.name = 'secret product data: Parle-G';
        throw error;
      }
      render(
        <AppErrorBoundary>
          <Hostile />
        </AppErrorBoundary>
      );
      const ours = consoleError.mock.calls.find(([first]) => first === 'ShopStock UI failure:');
      expect(ours[1]).toBe('Error');
      expect(JSON.stringify(ours)).not.toContain('secret product data');
      expect(JSON.stringify(ours)).not.toContain('hidden');
    });

    it('the boundary also copes with a thrown non-Error value', () => {
      function ThrowsString() {
        throw 'Parle-G exploded'; // eslint-disable-line no-throw-literal
      }
      render(
        <AppErrorBoundary>
          <ThrowsString />
        </AppErrorBoundary>
      );
      const ours = consoleError.mock.calls.find(([first]) => first === 'ShopStock UI failure:');
      expect(ours[1]).toBe('Error');
      expect(JSON.stringify(ours)).not.toContain('Parle-G exploded');
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  it('keeps working when the failure came from a nested subtree', () => {
    render(
      <AppErrorBoundary>
        <main>
          <section>
            <Bomb />
          </section>
        </main>
      </AppErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
