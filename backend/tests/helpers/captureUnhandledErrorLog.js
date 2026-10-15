// For a test that DELIBERATELY drives an unexpected (non-AppError) failure
// through the real error handler. errorHandler.js logs those with
//
//   console.error('[ShopStock backend] Unhandled error:', err)
//
// on purpose: it is the production diagnostic and must stay. In a test that
// provokes it deliberately, the log is part of the behaviour under test, so
// it is captured and asserted instead of printed.
//
//   test('...', async (t) => {
//     const logged = captureUnhandledErrorLog(t);
//     ...exercise the failure...
//     assert.equal(logged.length, 1);
//     assert.equal(logged[0].message, 'the thrown message');
//   });
//
// Only that one diagnostic is captured. Every other console.error call still
// reaches the real console, so an unexpected error is never hidden. The
// capture is scoped to the test context `t` and restored automatically when
// the test ends, even if it fails.

export const UNHANDLED_ERROR_PREFIX = '[ShopStock backend] Unhandled error:';

/**
 * @param {import('node:test').TestContext} t
 * @returns {unknown[]} the errors passed to the diagnostic, in order
 */
export function captureUnhandledErrorLog(t) {
  const realConsoleError = console.error;
  const captured = [];
  t.mock.method(console, 'error', (...args) => {
    if (args[0] === UNHANDLED_ERROR_PREFIX) {
      captured.push(args[1]);
      return;
    }
    realConsoleError(...args);
  });
  return captured;
}
