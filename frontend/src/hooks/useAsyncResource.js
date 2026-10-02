import { useCallback, useEffect, useRef, useState } from 'react';

// Load-state for one independent piece of a screen (Phase 7C).
//
// Extracted because three concrete consumers need exactly this: the
// dashboard's inventory section, its recent-activity section, and the
// classification list. Each must have its own loading / error / retry so
// that one failing section never blanks an unrelated one.
//
//   const resource = useAsyncResource(() => service.load(id), [service, id]);
//   resource.status   'loading' | 'success' | 'error'
//   resource.data     last successful result (kept while reloading)
//   resource.error    Error | null
//   resource.isReloading  true while refreshing existing data
//   resource.reload() run the loader again (retry, or refresh after a change)
//
// A response that arrives after the inputs changed or the component
// unmounted is ignored, so stale data never overwrites newer data.

export function useAsyncResource(loader, deps = []) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({
    status: 'loading',
    data: undefined,
    error: null,
    isReloading: false
  });

  useEffect(() => {
    let cancelled = false;

    setState((previous) =>
      previous.data === undefined
        ? { status: 'loading', data: undefined, error: null, isReloading: false }
        : { status: 'success', data: previous.data, error: null, isReloading: true }
    );

    loaderRef.current().then(
      (data) => {
        if (!cancelled) setState({ status: 'success', data, error: null, isReloading: false });
      },
      (error) => {
        if (!cancelled) setState((previous) => ({ ...previous, status: 'error', error, isReloading: false }));
      }
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, reload };
}
