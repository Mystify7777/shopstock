import { useMemo, useRef, useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import ResourceView from '../components/ResourceView.jsx';
import NotFoundState from '../components/NotFoundState.jsx';
import { classifyStockStatus, needsAttention, STOCK_STATUS } from '../domain/classification/lowStock.js';
import { canBeReversed } from '../domain/stock/reversal.js';
import {
  orderHistoryNewestFirst,
  describeHistoryEntry,
  formatEntryTime,
  formatEntryDate
} from '../domain/stock/historyDisplay.js';
import { todayDateOnly } from '../domain/shared/dates.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';

const UNDO_TOAST_DURATION_MS = 5000;

// Presentation-only number formatting. No currency symbol: the app has no
// currency setting (same choice as the dashboard).
const moneyFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const costFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Product detail + stock operations page (route /products/:id; the metadata
 * form is /products/:id/edit).
 *
 * Phase 3 built the behavior; Phase 7E redesigns and hardens it WITHOUT
 * changing what any operation does:
 *
 *  - The product and its stock history are two independent resources
 *    (useAsyncResource), each with its own loading / error / retry. After a
 *    stock operation both are simply RELOADED from the local services, which
 *    stay authoritative -- nothing here keeps a second copy of quantity,
 *    status or history, and the page never blanks while reloading.
 *  - Stock status comes from classifyStockStatus; reversal eligibility from
 *    canBeReversed (domain/stock/reversal.js). A reversal the service
 *    refuses (e.g. insufficient stock) is reported from the service's own
 *    errors -- no frontend-only reversal rules.
 *  - History is shown newest first (domain/stock/historyDisplay.js); events
 *    with the same timestamp keep the service's order.
 *  - Validation errors stay form-level (the service returns plain messages
 *    with no field keys); they are associated with the form's inputs through
 *    aria-describedby.
 *  - The undo notice is page-local (a global notification system is 7G),
 *    still ~5 s, still the real reverseEvent path, now with a Dismiss button
 *    and a persistent polite live region.
 *
 * Deliberately not shown (deferred by decision): cost and margin figures,
 * unit and classification names (a Product holds only ids), and Product
 * Change History (no read path exists).
 */
export default function ProductDetailPage() {
  const { productService, stockEventService } = useAppContext();
  const { id } = useParams();

  const productResource = useAsyncResource(
    async () => (await productService.getProduct(id)) ?? null,
    [productService, id]
  );
  const historyResource = useAsyncResource(() => stockEventService.getHistory(id), [stockEventService, id]);
  const orderedHistory = useMemo(
    () => (historyResource.data ? orderHistoryNewestFirst(historyResource.data) : []),
    [historyResource.data]
  );

  // Add Stock
  const [showAddForm, setShowAddForm] = useState(false);
  const [addQuantity, setAddQuantity] = useState('');
  const [addCost, setAddCost] = useState('');
  const [addPurchaseDate, setAddPurchaseDate] = useState('');
  const [addComment, setAddComment] = useState('');
  const [addErrors, setAddErrors] = useState([]);
  const [addSubmitError, setAddSubmitError] = useState(null);
  const [addSaving, setAddSaving] = useState(false);
  // True once the user has typed in the cost field. The latest-known-cost
  // prefill must never overwrite their input, including a deliberately
  // cleared field (PRD §11.1).
  const costTouchedRef = useRef(false);
  // Identifies the latest open of the form, so a prefill that resolves after
  // the form was closed or reopened is ignored.
  const prefillSeqRef = useRef(0);

  // Remove Stock
  const [showRemoveForm, setShowRemoveForm] = useState(false);
  const [removeQuantity, setRemoveQuantity] = useState('');
  const [removeComment, setRemoveComment] = useState('');
  const [removeErrors, setRemoveErrors] = useState([]);
  const [removeSubmitError, setRemoveSubmitError] = useState(null);
  const [removeSaving, setRemoveSaving] = useState(false);
  const [overRemoveWarning, setOverRemoveWarning] = useState(null); // { quantity, comment } | null

  // Reversal
  const [reverseErrors, setReverseErrors] = useState({}); // eventId -> string[]
  const [reverseSubmitError, setReverseSubmitError] = useState(null);
  const [reversingId, setReversingId] = useState(null);

  // Undo notice (page-local)
  const [undoToast, setUndoToast] = useState(null); // { eventId, message } | null
  const undoTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  function refreshAll() {
    productResource.reload();
    historyResource.reload();
  }

  function showUndoToast(eventId, message) {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }
    setUndoToast({ eventId, message });
    undoTimerRef.current = setTimeout(() => {
      setUndoToast(null);
      undoTimerRef.current = null;
    }, UNDO_TOAST_DURATION_MS);
  }

  function dismissUndoToast() {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoToast(null);
  }

  // ---------------------------------------------------------------------------
  // Add Stock
  // ---------------------------------------------------------------------------

  function closeAddForm() {
    prefillSeqRef.current += 1; // a pending prefill must not touch a closed form
    setShowAddForm(false);
  }

  async function openAddForm() {
    setShowRemoveForm(false);
    setOverRemoveWarning(null);
    setShowAddForm(true);
    setAddQuantity('');
    setAddCost('');
    setAddPurchaseDate(todayDateOnly());
    setAddComment('');
    setAddErrors([]);
    setAddSubmitError(null);
    costTouchedRef.current = false;

    prefillSeqRef.current += 1;
    const seq = prefillSeqRef.current;
    try {
      const latestCost = await stockEventService.getLatestKnownCost(id);
      // Apply the prefill only if this is still the same open of the form,
      // there is a cost to apply, and the user has not typed one.
      if (seq === prefillSeqRef.current && !costTouchedRef.current && latestCost !== null && latestCost !== undefined) {
        setAddCost(String(latestCost));
      }
    } catch {
      // The prefill is a convenience, not a required field: if it cannot be
      // read, the cost field simply stays empty and the user can type one.
    }
  }

  async function handleAddSubmit(event) {
    event.preventDefault();
    setAddSaving(true);
    setAddErrors([]);
    setAddSubmitError(null);

    try {
      const result = await stockEventService.addStock({
        productId: id,
        quantity: Number(addQuantity),
        costPerUnit: addCost === '' ? undefined : Number(addCost),
        purchaseDate: addPurchaseDate === '' ? undefined : addPurchaseDate,
        comment: addComment
      });

      if (result.errors.length > 0) {
        setAddErrors(result.errors);
        setAddSaving(false);
        return;
      }

      setAddSaving(false);
      closeAddForm();
      refreshAll();
      showUndoToast(result.event.id, `Stock increased by ${result.event.appliedQuantity}`);
    } catch (err) {
      // The page and everything entered stay as they were; Save can be retried.
      setAddSubmitError(err.message);
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Remove Stock
  // ---------------------------------------------------------------------------

  function openRemoveForm() {
    closeAddForm();
    setShowRemoveForm(true);
    setRemoveQuantity('');
    setRemoveComment('');
    setRemoveErrors([]);
    setRemoveSubmitError(null);
    setOverRemoveWarning(null);
  }

  function closeRemoveForm() {
    setShowRemoveForm(false);
    setOverRemoveWarning(null);
  }

  async function handleRemoveSubmit(event) {
    event.preventDefault();
    setRemoveErrors([]);
    setRemoveSubmitError(null);

    const quantity = Number(removeQuantity);

    try {
      const wouldOverRemove = await stockEventService.wouldOverRemove(id, quantity);
      if (wouldOverRemove) {
        setOverRemoveWarning({ quantity, comment: removeComment });
        return;
      }
    } catch (err) {
      setRemoveSubmitError(err.message);
      return;
    }

    await commitRemoval(quantity, removeComment);
  }

  async function handleConfirmOverRemove() {
    if (!overRemoveWarning) return;
    const { quantity, comment } = overRemoveWarning;
    setOverRemoveWarning(null);
    await commitRemoval(quantity, comment);
  }

  function handleCancelOverRemove() {
    setOverRemoveWarning(null);
  }

  async function commitRemoval(quantity, comment) {
    setRemoveSaving(true);
    try {
      const result = await stockEventService.removeStock({
        productId: id,
        quantity,
        comment
      });

      if (result.errors.length > 0) {
        setRemoveErrors(result.errors);
        setRemoveSaving(false);
        return;
      }

      setRemoveSaving(false);
      setShowRemoveForm(false);
      refreshAll();
      showUndoToast(result.event.id, `Stock reduced by ${result.event.appliedQuantity}`);
    } catch (err) {
      setRemoveSubmitError(err.message);
      setRemoveSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Reversal (undo notice button AND per-history-entry "Reverse this action")
  // ---------------------------------------------------------------------------

  async function handleReverse(eventId) {
    setReverseErrors((prev) => ({ ...prev, [eventId]: [] }));
    setReverseSubmitError(null);
    setReversingId(eventId);

    try {
      const result = await stockEventService.reverseEvent(eventId);
      if (result.errors.length > 0) {
        setReverseErrors((prev) => ({ ...prev, [eventId]: result.errors }));
        return;
      }
      dismissUndoToast();
      refreshAll();
    } catch (err) {
      setReverseSubmitError(err.message);
    } finally {
      setReversingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function describedBy(...ids) {
    const present = ids.filter(Boolean);
    return present.length > 0 ? present.join(' ') : undefined;
  }

  function renderHistoryEntry(entry) {
    const d = describeHistoryEntry(entry);
    const time = formatEntryTime(d.recordedAt);
    const purchased = formatEntryDate(d.purchaseDate);
    const errors = reverseErrors[entry.id];

    return (
      <li key={entry.id} className="history-entry">
        <div className="history-entry__main">
          <span className={`history-entry__amount history-entry__amount--${d.direction}`}>
            {d.direction === 'added' ? '+' : '-'}
            {d.amount}
          </span>
          <span className="history-entry__kind">{d.direction === 'added' ? 'Added' : 'Removed'}</span>
          {d.isReversal && <span className="history-entry__badge">Reversal</span>}
          {d.isReversed && <span className="history-entry__badge history-entry__badge--muted">Reversed</span>}
          {time && (
            <time className="history-entry__time" dateTime={d.recordedAt}>
              {time}
            </time>
          )}
        </div>

        <p className="history-entry__comment">{d.comment || 'No justification provided'}</p>

        {d.wasClamped && (
          <p className="history-entry__detail">
            {d.requested} requested, but only {d.amount} {d.amount === 1 ? 'was' : 'were'} available.
          </p>
        )}
        {d.direction === 'added' && (purchased || d.costPerUnit !== undefined) && (
          <p className="history-entry__detail">
            {purchased && <>Purchased {purchased}. </>}
            {d.costPerUnit === null ? 'No cost recorded.' : `Cost per unit: ${costFormat.format(d.costPerUnit)}.`}
          </p>
        )}

        {canBeReversed(entry) && (
          <button type="button" onClick={() => handleReverse(entry.id)} disabled={reversingId !== null}>
            Reverse this action
          </button>
        )}
        {errors && errors.length > 0 && (
          <ul role="alert" className="form-errors">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="product-detail">
      <Link to="/products" className="product-detail__back">
        &lsaquo; Products
      </Link>

      <ResourceView
        resource={productResource}
        loadingMessage="Loading product…"
        errorMessage="Couldn't load this product."
        showDetail
      >
        {(product) => {
          if (product === null) {
            return (
              <NotFoundState
                message="Product not found."
                linkTo="/products"
                linkLabel="Back to Products"
              />
            );
          }

          const status = classifyStockStatus({
            quantity: product.quantity,
            globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
            productThresholdOverride: product.lowStockThreshold,
            lowStockDisabled: product.lowStockDisabled
          });
          const lowStock = needsAttention(status);
          const hasPrice = typeof product.sellingPrice === 'number' && Number.isFinite(product.sellingPrice);

          return (
            <>
              <div className="product-detail__header">
                <h1>{product.name || 'Unnamed product'}</h1>
                <Link to={`/products/${id}/edit`} className="product-detail__edit">
                  Edit Product
                </Link>
              </div>

              <div className="product-detail__summary" aria-busy={productResource.isReloading}>
                <p className="product-detail__quantity">
                  Quantity: {product.quantity}
                  {lowStock ? (
                    <span role="status" className={`stock-badge stock-badge--${status === STOCK_STATUS.OUT ? 'out' : 'low'}`}>
                      {status}
                    </span>
                  ) : (
                    <span className="stock-badge stock-badge--ok">In stock</span>
                  )}
                </p>
                {hasPrice && <p>Selling price: {moneyFormat.format(product.sellingPrice)}</p>}
              </div>

              <div className="product-detail__actions">
                <button
                  type="button"
                  onClick={showAddForm ? closeAddForm : openAddForm}
                  aria-expanded={showAddForm}
                  aria-controls="add-stock-form"
                >
                  Add Stock
                </button>
                <button
                  type="button"
                  onClick={showRemoveForm ? closeRemoveForm : openRemoveForm}
                  aria-expanded={showRemoveForm}
                  aria-controls="remove-stock-form"
                >
                  Remove Stock
                </button>
              </div>

              {/* Persistent polite live region: its content changes, the region does not. */}
              <div className="undo-slot" role="status" aria-live="polite">
                {undoToast && (
                  <div className="undo-notice">
                    <span>{undoToast.message}</span>
                    <button type="button" onClick={() => handleReverse(undoToast.eventId)} disabled={reversingId !== null}>
                      Undo
                    </button>
                    <button type="button" onClick={dismissUndoToast}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
              {reverseSubmitError && <p role="alert">{reverseSubmitError}</p>}

              {showAddForm && (
                <form id="add-stock-form" className="stock-form" onSubmit={handleAddSubmit}>
                  {addErrors.length > 0 && (
                    <ul role="alert" id="add-form-errors" className="form-errors">
                      {addErrors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  )}
                  {addSubmitError && (
                    <p role="alert" id="add-form-submit-error" className="form-errors">
                      {addSubmitError}
                    </p>
                  )}

                  <div className="stock-form__field">
                    <label htmlFor="add-quantity">Quantity</label>
                    <input
                      id="add-quantity"
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={addQuantity}
                      onChange={(e) => setAddQuantity(e.target.value)}
                      aria-describedby={describedBy(addErrors.length > 0 && 'add-form-errors', addSubmitError && 'add-form-submit-error')}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="add-cost">Cost per unit</label>
                    <input
                      id="add-cost"
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={addCost}
                      onChange={(e) => {
                        costTouchedRef.current = true;
                        setAddCost(e.target.value);
                      }}
                      aria-describedby={describedBy(addErrors.length > 0 && 'add-form-errors', addSubmitError && 'add-form-submit-error')}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="add-purchase-date">Purchase date</label>
                    <input
                      id="add-purchase-date"
                      type="date"
                      value={addPurchaseDate}
                      onChange={(e) => setAddPurchaseDate(e.target.value)}
                      aria-describedby={describedBy(addErrors.length > 0 && 'add-form-errors', addSubmitError && 'add-form-submit-error')}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="add-comment">Comment</label>
                    <input
                      id="add-comment"
                      type="text"
                      value={addComment}
                      onChange={(e) => setAddComment(e.target.value)}
                    />
                  </div>
                  <button type="submit" disabled={addSaving}>
                    {addSaving ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}

              {showRemoveForm && (
                <form id="remove-stock-form" className="stock-form" onSubmit={handleRemoveSubmit}>
                  {removeErrors.length > 0 && (
                    <ul role="alert" id="remove-form-errors" className="form-errors">
                      {removeErrors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  )}
                  {removeSubmitError && (
                    <p role="alert" id="remove-form-submit-error" className="form-errors">
                      {removeSubmitError}
                    </p>
                  )}

                  <div className="stock-form__field">
                    <label htmlFor="remove-quantity">Quantity</label>
                    <input
                      id="remove-quantity"
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={removeQuantity}
                      onChange={(e) => setRemoveQuantity(e.target.value)}
                      aria-describedby={describedBy(removeErrors.length > 0 && 'remove-form-errors', removeSubmitError && 'remove-form-submit-error')}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="remove-comment">Comment</label>
                    <input
                      id="remove-comment"
                      type="text"
                      value={removeComment}
                      onChange={(e) => setRemoveComment(e.target.value)}
                    />
                  </div>
                  <button type="submit" disabled={removeSaving}>
                    {removeSaving ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}

              {overRemoveWarning && (
                <div role="alertdialog" className="over-remove-warning">
                  <p>
                    Only {product.quantity} units are currently available. Remove{' '}
                    {overRemoveWarning.quantity} anyway?
                  </p>
                  <button type="button" onClick={handleCancelOverRemove}>
                    Cancel
                  </button>
                  <button type="button" onClick={handleConfirmOverRemove}>
                    Continue
                  </button>
                </div>
              )}

              <section className="product-detail__history" aria-busy={historyResource.isReloading}>
                <h2>Stock History</h2>
                <ResourceView
                  resource={historyResource}
                  loadingMessage="Loading history…"
                  errorMessage="Couldn't load the stock history."
                  showDetail
                >
                  {() =>
                    orderedHistory.length === 0 ? (
                      <p>No stock history yet.</p>
                    ) : (
                      <ul className="history-list">{orderedHistory.map(renderHistoryEntry)}</ul>
                    )
                  }
                </ResourceView>
              </section>
            </>
          );
        }}
      </ResourceView>
    </div>
  );
}
