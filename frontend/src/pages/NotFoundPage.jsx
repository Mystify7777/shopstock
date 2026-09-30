import NotFoundState from '../components/NotFoundState.jsx';

/**
 * Catch-all route (Phase 7B). Rendered inside the app shell, so the
 * header and primary navigation remain available as safe exits.
 */
export default function NotFoundPage() {
  return (
    <section>
      <h1>Page not found</h1>
      <NotFoundState
        message="That page doesn't exist."
        linkTo="/products"
        linkLabel="Back to Products"
      />
    </section>
  );
}
