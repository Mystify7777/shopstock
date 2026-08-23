import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';

/**
 * Minimal product create/edit form -- Phase 2.4 vertical slice.
 *
 * Fields limited to name + notes, deliberately, to prove the full
 * UI -> service -> domain -> repository -> Dexie path without requiring
 * classification pickers, photo upload, or pricing fields. Distinguishes
 * create vs. edit by whether a route :id param is present.
 */
export default function ProductFormPage() {
  const { productService } = useAppContext();
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);

  const [existingProduct, setExistingProduct] = useState(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(isEdit);
  // notFound and loadError are local, page-scoped states -- no global error
  // infrastructure introduced. notFound: the id resolved to no product.
  // loadError: getProduct() itself rejected (unexpected failure, not a
  // normal "no such product" outcome).
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    if (!isEdit) return;

    let cancelled = false;

    async function load() {
      try {
        const product = await productService.getProduct(id);
        if (cancelled) return;

        if (!product) {
          // getProduct() resolved with no error but found nothing --
          // an explicit not-found state, not an infinite loading spinner.
          setNotFound(true);
          setLoading(false);
          return;
        }

        setExistingProduct(product);
        setName(product.name || '');
        setNotes(product.notes || '');
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id, isEdit, productService]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setErrors([]);
    setSubmitError(null);

    try {
      const result = isEdit
        ? await productService.updateProduct(existingProduct, { name, notes })
        : await productService.createProduct({ name, notes });

      if (result.errors.length > 0) {
        // Domain validation errors -- inline, expected, recoverable.
        setErrors(result.errors);
        setSaving(false);
        return;
      }

      navigate('/products');
      // Deliberately no setSaving(false) here on the success path before
      // navigation -- the component is about to unmount. Doing so is
      // harmless either way, but the failure path below always resets it.
    } catch (err) {
      // Unexpected rejection (not a domain validation result) -- surfaced
      // as a distinct UI error state rather than an unhandled rejection
      // or a silently stuck "Saving…" button.
      setSubmitError(err.message);
      setSaving(false);
    }
  }

  if (loading) {
    return <p>Loading&hellip;</p>;
  }

  if (notFound) {
    return <p role="alert">Product not found.</p>;
  }

  if (loadError) {
    return <p role="alert">{loadError}</p>;
  }

  return (
    <div>
      <h1>{isEdit ? 'Edit Product' : 'Add Product'}</h1>

      {errors.length > 0 && (
        <ul role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {submitError && <p role="alert">{submitError}</p>}

      <form onSubmit={handleSubmit}>
        <label htmlFor="product-name">Name</label>
        <input
          id="product-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <label htmlFor="product-notes">Notes</label>
        <textarea
          id="product-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />

        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}
