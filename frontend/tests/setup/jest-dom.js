// jest-dom matchers (toBeInTheDocument, toHaveTextContent, etc.) are only
// meaningful when a DOM exists. This file is loaded globally (see
// vite.config.js setupFiles) but the import itself is guarded so it has no
// effect under the `node` environment used by domain/repository/service
// tests -- only component tests running under `jsdom` (see
// environmentMatchGlobs in vite.config.js) actually get the matchers.
//
// This keeps a single setupFiles list rather than requiring Vitest to
// support per-environment setupFiles (which v2.1.9 does not).
//
// The '/vitest' subpath extends Vitest's own `expect` explicitly, which is
// the correct entry point for this project -- Vitest globals (globals:
// true) are not enabled anywhere in vite.config.js, so every test file
// imports describe/it/expect explicitly. The default jest-dom entry point
// assumes a global `expect` and throws ReferenceError without globals mode.
//
// React Testing Library's DOM cleanup between tests also relies on a
// global `afterEach` unless explicitly wired -- since globals mode is not
// enabled here either, we import { afterEach } from vitest and register
// RTL's cleanup() explicitly. Without this, DOM from one test's render()
// call leaks into the next test in the same file.
if (typeof document !== 'undefined') {
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  await import('@testing-library/jest-dom/vitest');
  afterEach(() => {
    cleanup();
  });
}
