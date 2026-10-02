/**
 * Renders the loading / error (with retry) / content states of a
 * useAsyncResource() result, so each section of a screen shows them the
 * same way. Content is only rendered once data exists.
 *
 * Deliberately plain: a status line, an alert with a retry button, or the
 * caller's content. Messages are friendly text, not raw error strings.
 *
 * @param {{
 *   resource: ReturnType<import('../hooks/useAsyncResource.js').useAsyncResource>,
 *   loadingMessage: string,
 *   errorMessage: string,
 *   children: (data: any) => import('react').ReactNode
 * }} props
 */
export default function ResourceView({ resource, loadingMessage, errorMessage, children }) {
  if (resource.status === 'loading') {
    return <p role="status">{loadingMessage}</p>;
  }

  if (resource.status === 'error') {
    return (
      <div role="alert" className="resource-error">
        <p>{errorMessage}</p>
        <button type="button" onClick={resource.reload}>
          Try again
        </button>
      </div>
    );
  }

  return children(resource.data);
}
