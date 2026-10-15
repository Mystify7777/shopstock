import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { captureConsoleError } from './captureConsoleError.js';

// Tests of the helper itself. `underlying` plays the part of the console.error
// that is in place before the helper is installed: it is where forwarded
// (unexpected) calls must end up.
function installUnderlying() {
  const underlying = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => underlying.mockRestore());
  return underlying;
}

describe('captureConsoleError', () => {
  it('records a call whose first argument is exactly the expected message, and keeps it off the console', () => {
    const underlying = installUnderlying();
    const captured = captureConsoleError('Saving failed.');
    const cause = new Error('disk full');

    console.error('Saving failed.', cause);

    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith('Saving failed.', cause);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('counts each expected call, so an exact call count is meaningful', () => {
    installUnderlying();
    const captured = captureConsoleError('Saving failed.');
    console.error('Saving failed.', 1);
    console.error('Saving failed.', 2);
    expect(captured).toHaveBeenCalledTimes(2);
  });

  it('forwards every other call, with all its arguments, and does not record it', () => {
    const underlying = installUnderlying();
    const captured = captureConsoleError('Saving failed.');
    const unexpected = new Error('something else broke');

    console.error('A different message.', 42);
    console.error(unexpected);
    console.error('Warning: Each child in a list should have a unique "key" prop.', 'Foo');

    expect(captured).not.toHaveBeenCalled();
    expect(underlying).toHaveBeenCalledTimes(3);
    expect(underlying).toHaveBeenNthCalledWith(1, 'A different message.', 42);
    expect(underlying).toHaveBeenNthCalledWith(2, unexpected);
    expect(underlying).toHaveBeenNthCalledWith(
      3,
      'Warning: Each child in a list should have a unique "key" prop.',
      'Foo'
    );
  });

  it('matches the message exactly, not by prefix or substring', () => {
    const underlying = installUnderlying();
    const captured = captureConsoleError('Saving failed.');

    console.error('Saving failed. And then some more');
    console.error('Error: Saving failed.');
    console.error('saving failed.');

    expect(captured).not.toHaveBeenCalled();
    expect(underlying).toHaveBeenCalledTimes(3);
  });

  it('an unexpected diagnostic alongside the expected one is still forwarded', () => {
    const underlying = installUnderlying();
    const captured = captureConsoleError('Saving failed.');

    console.error('Saving failed.', new Error('expected'));
    console.error('Unexpected failure', new Error('surprise'));

    expect(captured).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledWith('Unexpected failure', expect.objectContaining({ message: 'surprise' }));
  });

  it.each([[undefined], [null], [''], [42], [{}], [/regex/]])(
    'refuses %p: it will not become a catch-all',
    (bad) => {
      expect(() => captureConsoleError(bad)).toThrow(TypeError);
    }
  );

  describe('cleanup', () => {
    it('step 1: installs the capture', () => {
      const captured = captureConsoleError('Saving failed.');
      console.error('Saving failed.');
      expect(captured).toHaveBeenCalledTimes(1);
    });

    it('step 2: the previous test\'s capture did not leak into this one', () => {
      // console.error is the real (or vitest-provided) function again, not a mock.
      expect(vi.isMockFunction(console.error)).toBe(false);
    });
  });
});
