import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import NotFoundState from '../components/NotFoundState.jsx';
import ResourceView from '../components/ResourceView.jsx';

/**
 * Product create/edit form (Phase 7F, Issue #22).
 *
 * Scope is deliberately the existing two fields, name and notes. The page
 * is a UI adapter only: validation stays in the domain, change detection
 * and ProductChangeEvents in productService, persistence and sync in the
 * repository. What this file owns is the form's own write semantics --
 * what it hands to the service.
 *
 *   create  productService.createProduct({ name, notes })
 *   edit    productService.updateProduct(snapshot, patch), where `patch`
 *           holds ONLY the fields that actually changed. An empty patch
 *           is a no-op: nothing is written, no ProductChangeEvent is
 *           created, nothing is queued for sync.
 *
 * Name is trimmed on submit. For comparison, null / undefined / '' /
 * whitespace-only names are all "no name", so opening a photo-only
 * product (name null) and saving untouched cannot create a false
 * null -> '' change.
 */

/** "No name" in all its forms compares as ''. Used for the name field only. */
function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A missing note and an empty note are the same thing. */
function normalizeNotes(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Build the edit patch: only the editable fields whose normalized value
 * differs from the snapshot the form was opened with.
 */
function buildPatch(product, name, notes) {
  const patch = {};
  const nextName = normalizeName(name);
  if (nextName !== normalizeName(product.name)) {
    patch.name = nextName;
  }
  if (notes !== normalizeNotes(product.notes)) {
    patch.notes = notes;
  }
  return patch;
}

function describedBy(...ids) {
  const present = ids.filter(Boolean);
  return present.length > 0 ? present.join(' ') : undefined;
}

export default function ProductFormPage() {
  const { id } = useParams();
  // key={id}: moving between two products must not reuse form state.
  return id ? <EditProduct key={id} id={id} /> : <ProductForm product={null} />;
}

/** Edit mode: load the product, then render the form from that snapshot. */
function EditProduct({ id }) {
  const { productService } = useAppContext();
  const resource = useAsyncResource(() => productService.getProduct(id), [productService, id]);

  return (
    <ResourceView
      resource={resource}
      loadingMessage="Loading product…"
      errorMessage="We couldn't load this product."
    >
      {(product) =>
        product ? (
          <ProductForm product={product} />
        ) : (
          <NotFoundState message="Product not found." linkTo="/products" linkLabel="Back to Products" />
        )
      }
    </ResourceView>
  );
}

/**
 * @param {{ product: object|null }} props The loaded snapshot in edit
 *   mode, or null when creating.
 */
function ProductForm({ product }) {
  const { productService } = useAppContext();
  const navigate = useNavigate();
  const isEdit = product !== null;

  const [name, setName] = useState(product?.name || '');
  const [notes, setNotes] = useState(product?.notes || '');
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const cancelTo = isEdit ? `/products/${product.id}` : '/products';

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;

    setErrors([]);
    setSaveFailed(false);

    let patch = null;
    if (isEdit) {
      patch = buildPatch(product, name, notes);
      if (Object.keys(patch).length === 0) {
        // Nothing changed: no write, no change events, no sync.
        navigate(`/products/${product.id}`);
        return;
      }
    }

    setSaving(true);
    try {
      const result = isEdit
        ? await productService.updateProduct(product, patch)
        : await productService.createProduct({ name: normalizeName(name), notes });

      if (result.errors.length > 0) {
        // Domain validation: expected and recoverable. Entered values stay.
        setErrors(result.errors);
        setSaving(false);
        return;
      }

      navigate(`/products/${result.product.id}`);
    } catch (err) {
      // Unexpected failure (local write failed, or the product changed
      // underneath this form). Shown as a friendly message, never the raw
      // exception text; the entered values stay as they are.
      console.error('Saving the product failed.', err);
      setSaveFailed(true);
      setSaving(false);
    }
  }

  const hasErrors = errors.length > 0;

  return (
    <div className="product-form">
      <h1>{isEdit ? 'Edit Product' : 'Add Product'}</h1>
      <p className="product-form__context">
        {isEdit
          ? 'Change the details below, then save.'
          : 'Add a product to your stock. You can add stock to it after saving.'}
      </p>

      <form onSubmit={handleSubmit} noValidate>
        {hasErrors && (
          <ul role="alert" id="product-form-errors" className="form-errors">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        {saveFailed && (
          <p role="alert" id="product-form-save-error" className="form-errors">
            We couldn&rsquo;t save this product. Your changes are still here &mdash; please try again.
          </p>
        )}

        <fieldset className="product-form__group">
          <legend>Product details</legend>

          <div className="product-form__field">
            <label htmlFor="product-name">Name</label>
            <input
              id="product-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              // Every error the domain can return for this form is the
              // name-or-photo identity rule, so the list belongs to this input.
              aria-invalid={hasErrors || undefined}
              aria-describedby={describedBy('product-name-help', hasErrors && 'product-form-errors')}
            />
            <p id="product-name-help" className="product-form__help">
              The name you&rsquo;ll look for when searching.
            </p>
          </div>

          <div className="product-form__field">
            <label htmlFor="product-notes">Notes (optional)</label>
            <textarea
              id="product-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              aria-describedby="product-notes-help"
            />
            <p id="product-notes-help" className="product-form__help">
              Anything worth remembering about this product.
            </p>
          </div>
        </fieldset>

        <div className="product-form__actions">
          <button
            type="submit"
            className="product-form__submit"
            disabled={saving}
            aria-describedby={describedBy(saveFailed && 'product-form-save-error')}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <Link to={cancelTo} className="product-form__cancel">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
