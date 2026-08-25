import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { classifyStockStatus, needsAttention } from '../domain/classification/lowStock.js';
import { canBeReversed } from '../domain/stock/reversal.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';

const UNDO_TOAST_DURATION_MS = 5000;

/**
 * Product detail + stock operations page -- Phase 3 vertical slice.
 *
 * /products/:id. Distinct from /products/:id/edit (metadata only, unchanged
 * from Phase 2.4). This page shows current quantity, low-stock status
 * (same domain function ProductListPage already uses), stock history, an
 * Add Stock form, a Remove Stock form (with the PRD §12 over-removal
 * warning), an "Edit Product" link to the metadata form, and a ~5-second
 * local undo banner after any successful stock mutation.
 *
 * productService.getProduct() and stockEventService.getHistory() are
 * called independently -- no combined loader, per the approved Phase 3
 * contract. Each has its own loading/error state.
 */
export default function ProductDetailPage() {
  const { productService, stockEventService } = useAppContext();
  const navigate = useNavigate();
  const { id } = useParams();

  const [product, setProduct] = useState(null);
  const [productLoading, setProductLoading] = useState(true);
  const [productError, setProductError] = useState(null);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(null);

  const [latestKnownCost, setLatestKnownCost] = useState(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addQuantity, setAddQuantity] = useState('');
  const [addCost, setAddCost] = useState('');
  const [addPurchaseDate, setAddPurchaseDate] = useState('');
  const [addComment, setAddComment] = useState('');
  const [addErrors, setAddErrors] = useState([]);
  const [addSubmitError, setAddSubmitError] = useState(null);
  const [addSaving, setAddSaving] = useState(false);

  const [showRemoveForm, setShowRemoveForm] = useState(false);
  const [removeQuantity, setRemoveQuantity] = useState('');
  const [removeComment, setRemoveComment] = useState('');
  const [removeErrors, setRemoveErrors] = useState([]);
  const [removeSubmitError, setRemoveSubmitError] = useState(null);
  const [removeSaving, setRemoveSaving] = useState(false);
  const [overRemoveWarning, setOverRemoveWarning] = useState(null); // { quantity, comment } | null

  const [reverseErrors, setReverseErrors] = useState({}); // eventId -> string[]
  const [reverseSubmitError, setReverseSubmitError] = useState(null);

  const [undoToast, setUndoToast] = useState(null); // { eventId, message } | null
  const undoTimerRef = useRef(null);

  // isCancelledRef is an optional ref cell (`{ current: boolean }`) whose
  // value is checked immediately before EVERY state update inside these
  // loaders -- not just once before the async call starts. This is what
  // actually prevents a state update on an unmounted component: checking
  // `cancelled` only before `await loadProduct()` begins (the previous
  // approach) does nothing once the call is already in flight, since
  // loadProduct() itself had no way to know the component had unmounted
  // in the meantime. When called without a ref (e.g. after a mutation,
  // later in this same render tree, when the component is known to still
  // be mounted), the guard is simply skipped -- no behavior change for
  // those call sites.
  const loadProduct = useCallback(async (isCancelledRef) => {
    setProductLoading(true);
    setProductError(null);
    try {
      const result = await productService.getProduct(id);
      if (isCancelledRef?.current) return;
      setProduct(result || null);
      setProductLoading(false);
    } catch (err) {
      if (isCancelledRef?.current) return;
      setProductError(err.message);
      setProductLoading(false);
    }
  }, [id, productService]);

  const loadHistory = useCallback(async (isCancelledRef) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await stockEventService.getHistory(id);
      if (isCancelledRef?.current) return;
      setHistory(result);
      setHistoryLoading(false);
    } catch (err) {
      if (isCancelledRef?.current) return;
      setHistoryError(err.message);
      setHistoryLoading(false);
    }
  }, [id, stockEventService]);

  const loadLatestKnownCost = useCallback(async () => {
    try {
      const cost = await stockEventService.getLatestKnownCost(id);
      setLatestKnownCost(cost);
    } catch {
      // Prefill is a convenience, not a required field -- a failure here
      // should not block the page. The cost field simply starts empty.
      setLatestKnownCost(null);
    }
  }, [id, stockEventService]);

  useEffect(() => {
    const isCancelledRef = { current: false };
    loadProduct(isCancelledRef);
    return () => {
      isCancelledRef.current = true;
    };
  }, [loadProduct]);

  useEffect(() => {
    const isCancelledRef = { current: false };
    loadHistory(isCancelledRef);
    return () => {
      isCancelledRef.current = true;
    };
  }, [loadHistory]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

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

  function openAddForm() {
    setShowAddForm(true);
    setAddQuantity('');
    setAddCost(latestKnownCost !== null ? String(latestKnownCost) : '');
    setAddPurchaseDate('');
    setAddComment('');
    setAddErrors([]);
    setAddSubmitError(null);
    loadLatestKnownCost();
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
      setShowAddForm(false);
      await loadProduct();
      await loadHistory();
      showUndoToast(result.event.id, `Stock increased by ${result.event.appliedQuantity}`);
    } catch (err) {
      setAddSubmitError(err.message);
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Remove Stock
  // ---------------------------------------------------------------------------

  function openRemoveForm() {
    setShowRemoveForm(true);
    setRemoveQuantity('');
    setRemoveComment('');
    setRemoveErrors([]);
    setRemoveSubmitError(null);
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
      await loadProduct();
      await loadHistory();
      showUndoToast(result.event.id, `Stock reduced by ${result.event.appliedQuantity}`);
    } catch (err) {
      setRemoveSubmitError(err.message);
      setRemoveSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Reversal (undo toast button AND per-history-entry "Reverse this action")
  // ---------------------------------------------------------------------------

  async function handleReverse(eventId) {
    setReverseErrors((prev) => ({ ...prev, [eventId]: [] }));
    setReverseSubmitError(null);

    try {
      const result = await stockEventService.reverseEvent(eventId);

      if (result.errors.length > 0) {
        setReverseErrors((prev) => ({ ...prev, [eventId]: result.errors }));
        return;
      }

      dismissUndoToast();
      await loadProduct();
      await loadHistory();
    } catch (err) {
      setReverseSubmitError(err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (productLoading) {
    return <p>Loading&hellip;</p>;
  }

  if (productError) {
    return <p role="alert">{productError}</p>;
  }

  if (!product) {
    return <p role="alert">Product not found.</p>;
  }

  const status = classifyStockStatus({
    quantity: product.quantity,
    globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    productThresholdOverride: product.lowStockThreshold,
    lowStockDisabled: product.lowStockDisabled
  });
  const lowStock = needsAttention(status);

  return (
    <div>
      <h1>{product.name || 'Unnamed product'}</h1>
      <p>
        Quantity: {product.quantity}
        {lowStock && <span role="status"> ({status})</span>}
      </p>

      <button onClick={() => navigate(`/products/${id}/edit`)}>Edit Product</button>

      {undoToast && (
        <div role="status">
          {undoToast.message}
          <button onClick={() => handleReverse(undoToast.eventId)}>Undo</button>
        </div>
      )}

      {reverseSubmitError && <p role="alert">{reverseSubmitError}</p>}

      <section>
        <button onClick={openAddForm}>Add Stock</button>
        {showAddForm && (
          <form onSubmit={handleAddSubmit}>
            {addErrors.length > 0 && (
              <ul role="alert">
                {addErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {addSubmitError && <p role="alert">{addSubmitError}</p>}

            <label htmlFor="add-quantity">Quantity</label>
            <input
              id="add-quantity"
              type="number"
              value={addQuantity}
              onChange={(e) => setAddQuantity(e.target.value)}
            />

            <label htmlFor="add-cost">Cost per unit</label>
            <input
              id="add-cost"
              type="number"
              value={addCost}
              onChange={(e) => setAddCost(e.target.value)}
            />

            <label htmlFor="add-purchase-date">Purchase date</label>
            <input
              id="add-purchase-date"
              type="date"
              value={addPurchaseDate}
              onChange={(e) => setAddPurchaseDate(e.target.value)}
            />

            <label htmlFor="add-comment">Comment</label>
            <input
              id="add-comment"
              type="text"
              value={addComment}
              onChange={(e) => setAddComment(e.target.value)}
            />

            <button type="submit" disabled={addSaving}>
              {addSaving ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}
      </section>

      <section>
        <button onClick={openRemoveForm}>Remove Stock</button>
        {showRemoveForm && (
          <form onSubmit={handleRemoveSubmit}>
            {removeErrors.length > 0 && (
              <ul role="alert">
                {removeErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {removeSubmitError && <p role="alert">{removeSubmitError}</p>}

            <label htmlFor="remove-quantity">Quantity</label>
            <input
              id="remove-quantity"
              type="number"
              value={removeQuantity}
              onChange={(e) => setRemoveQuantity(e.target.value)}
            />

            <label htmlFor="remove-comment">Comment</label>
            <input
              id="remove-comment"
              type="text"
              value={removeComment}
              onChange={(e) => setRemoveComment(e.target.value)}
            />

            <button type="submit" disabled={removeSaving}>
              {removeSaving ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}

        {overRemoveWarning && (
          <div role="alertdialog">
            <p>
              Only {product.quantity} units are currently available. Remove{' '}
              {overRemoveWarning.quantity} anyway?
            </p>
            <button onClick={handleCancelOverRemove}>Cancel</button>
            <button onClick={handleConfirmOverRemove}>Continue</button>
          </div>
        )}
      </section>

      <section>
        <h2>Stock History</h2>
        {historyLoading && <p>Loading history&hellip;</p>}
        {historyError && <p role="alert">{historyError}</p>}
        {!historyLoading && !historyError && history.length === 0 && (
          <p>No stock history yet.</p>
        )}
        {!historyLoading && !historyError && history.length > 0 && (
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                {entry.type === 'ADD' ? '+' : '-'}
                {entry.quantity} &mdash;{' '}
                {entry.comment || 'No justification provided'}
                {canBeReversed(entry) && (
                  <button onClick={() => handleReverse(entry.id)}>
                    Reverse this action
                  </button>
                )}
                {reverseErrors[entry.id] && reverseErrors[entry.id].length > 0 && (
                  <ul role="alert">
                    {reverseErrors[entry.id].map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
