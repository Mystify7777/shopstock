import React, { useEffect, useRef } from 'react';

/**
 * Last-resort fallback (Phase 7H). Replaces the whole app if rendering
 * throws, so the user never faces a blank screen.
 *
 * It deliberately depends on nothing else in the app -- no router, context
 * or store -- because any of those may be what failed. Recovery therefore
 * uses a plain reload and a plain link (a full page load).
 */
function AppErrorFallback() {
  const headingRef = useRef(null);

  // The tree was just replaced, so focus is lost; put it on the heading so
  // assistive technology announces what happened.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main className="app-error">
      <div className="app-error__card">
        <h1 ref={headingRef} tabIndex={-1}>
          Something went wrong
        </h1>
        <p>
          Part of ShopStock stopped working. Reloading usually fixes it. Anything you had not
          finished saving may be lost.
        </p>
        <div className="app-error__actions">
          <button type="button" className="app-error__reload" onClick={() => window.location.reload()}>
            Reload ShopStock
          </button>
          <a href="/" className="app-error__home">
            Go to Dashboard
          </a>
        </div>
      </div>
    </main>
  );
}

/** Error types that are safe to log by name (see AppErrorBoundary). */
const KNOWN_ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError'
]);

/** @returns {string} a built-in error type name, or 'Error' */
export function safeErrorType(error) {
  const name = error?.name;
  return typeof name === 'string' && KNOWN_ERROR_TYPES.has(name) ? name : 'Error';
}

/**
 * Catches errors thrown while rendering, in lifecycle methods, and in
 * constructors of everything below it. By design of React it does NOT catch
 * errors in event handlers or asynchronous code; the app already handles
 * those where they happen (friendly save and load failures, 7F / 7G).
 *
 * Diagnostics are sanitized: only a normalized error type and the component
 * stack are logged. The message and stack trace are not, because they can
 * contain product data or other user content. `error.name` is a mutable
 * property that any code can set to arbitrary text, so it is never logged
 * as-is: it is reduced to a built-in type from a fixed allowlist, and
 * everything else is reported as plain "Error". (React's own development-mode
 * console output is outside this component's control.) There is no
 * error-reporting service.
 */
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('ShopStock UI failure:', safeErrorType(error), info?.componentStack ?? '');
  }

  render() {
    return this.state.failed ? <AppErrorFallback /> : this.props.children;
  }
}
