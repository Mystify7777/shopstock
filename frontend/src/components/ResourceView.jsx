/**
 * Renders the loading / error (with retry) / content states of a
 * useAsyncResource() result, so each section of a screen shows them the
 * same way. Content is only rendered once data exists.
 *
 * Deliberately plain: a status line, an alert with a retry button, or the
 * caller's content. Messages are friendly text, not raw error strings --
 * unless the caller opts in with `showDetail`, which adds the underlying
 * error's own message on a separate line (for screens that already showed
 * it before this component existed).
 *
 * @param {{
 *   resource: ReturnType<import('../hooks/useAsyncResource.js').useAsyncResource>,
 *   loadingMessage: string,
 *   errorMessage: string,
 *   showDetail?: boolean,
 *   children: (data: any) => import('react').ReactNode
 * }} props
 */
export default function ResourceView({ resource, loadingMessage, errorMessage, showDetail = false, children }) {
  if (resource.status === 'loading') {
    return <p role="status">{loadingMessage}</p>;
  }

  if (resource.status === 'error') {
    return (
      <div role="alert" className="resource-error">
        <p>{errorMessage}</p>
        {showDetail && resource.error?.message && <p>{resource.error.message}</p>}
        <button type="button" onClick={resource.reload}>
          Try again
        </button>
      </div>
    );
  }

  return children(resource.data);
}
