import { vi, onTestFinished } from 'vitest';

/**
 * For a test that DELIBERATELY drives a failure path which the code under
 * test reports with console.error. Name the exact diagnostic you expect (the
 * first argument of the console.error call) and assert on what comes back:
 *
 *   const saveFailed = captureConsoleError('Saving the product failed.');
 *   ...exercise the failure...
 *   expect(saveFailed).toHaveBeenCalledTimes(1);
 *   expect(saveFailed).toHaveBeenCalledWith('Saving the product failed.', expect.any(Error));
 *
 * Guarantees:
 * - ONLY console.error calls whose first argument is exactly `expectedMessage`
 *   are captured (and kept off the console). Every other console.error call,
 *   including React warnings and any unexpected failure, is forwarded to the
 *   console.error that was in place before, untouched, so it still shows up.
 * - The returned function records ONLY the captured calls, so an exact
 *   toHaveBeenCalledTimes(n) is a real statement about that one diagnostic.
 *   Always assert the count: capturing without asserting would only hide it.
 * - It applies to this ONE test and is restored automatically afterwards,
 *   even when the test fails.
 *
 * @param {string} expectedMessage exact first argument of the expected call
 * @returns {import('vitest').Mock} records the captured calls only
 */
export function captureConsoleError(expectedMessage) {
  if (typeof expectedMessage !== 'string' || expectedMessage === '') {
    throw new TypeError(
      'captureConsoleError needs the exact message of the diagnostic you expect; it will not capture everything.'
    );
  }

  const realConsoleError = console.error;
  const captured = vi.fn();
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (args[0] === expectedMessage) {
      captured(...args);
      return;
    }
    realConsoleError.apply(console, args);
  });
  onTestFinished(() => spy.mockRestore());
  return captured;
}
