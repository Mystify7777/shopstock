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

// Unexpected failures are shown as these friendly messages; the underlying
// error is logged, never rendered. Validation messages returned by the
// service (result.errors) are unaffected and still shown as-is.
const STOCK_SAVE_FAILED = "We couldn't save that stock change. What you entered is still here \u2014 please try again.";
const STOCK_CHECK_FAILED = "We couldn't check the available stock. Please try again.";
const REVERSE_FAILED = "We couldn't undo that change. Please try again.";

// Presentation-only number formatting. No currency symbol: the app has no
// currency setting (same choice as the dashboard).
const moneyFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const costFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// The stock services return plain message strings with no field key, and the
// domain contract is not changed here, so a message is matched to the field it
// is about by its leading words. A message that matches no field (for example
// "Product not found.") belongs to no field: it is about the form as a whole and
// is announced by the form's alert only. The tests build real messages with the
// domain factories, so a wording change that breaks this match fails a test.
function stockErrorField(message) {
  if (message.startsWith('Quantity')) return 'quantity';
  if (message.startsWith('Cost per unit')) return 'cost';
  if (message.startsWith('Purchase date')) return 'purchaseDate';
  return null;
}

// The fields a set of messages marks invalid.
function invalidStockFields(errors) {
  return new Set(errors.map(stockErrorField).filter(Boolean));
}

// The ids of the error list items that are about `field` (see the list items'
// ids below), so a field is described by ITS messages and no one else's.
function fieldErrorIds(prefix, errors, field) {
  return errors.flatMap((message, index) => (stockErrorField(message) === field ? [`${prefix}-error-${index}`] : []));
}

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
 *  - Undo/dialog accessibility (7H Slice 2): the ~5 s expiry is paused while
 *    the pointer is over the notice or focus is inside it, then restarts in
 *    full; the notice never takes focus when it appears; focus is only moved
 *    when the element that HAD it is removed (Save, Dismiss, a successful
 *    Undo, the over-removal dialog), and then back to the control the user
 *    invoked; the over-removal dialog is named, focuses its safe
 *    (Cancel) button, and closes on Escape.
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
  const [undoInteraction, setUndoInteraction] = useState({ hover: false, focus: false });
  const [announcement, setAnnouncement] = useState(null); // transient, screen-reader-only
  const undoNoticeRef = useRef(null);
  const undoOriginRef = useRef('add'); // which action button the notice came from
  const reversingRef = useRef(false); // synchronous guard: one reversal at a time

  // Focus management. Refs for the controls focus can be returned to, and a
  // request object an effect acts on AFTER the render that made the target
  // focusable (e.g. a Save button that was disabled while saving).
  const addButtonRef = useRef(null);
  const removeButtonRef = useRef(null);
  const addFormRef = useRef(null);
  const removeFormRef = useRef(null);
  const addSaveRef = useRef(null);
  const removeSaveRef = useRef(null);
  const overRemoveRef = useRef(null);
  const overRemoveCancelRef = useRef(null);
  const historyHeadingRef = useRef(null);
  const historyReverseRefs = useRef(new Map()); // event id -> its "Reverse this action" button
  const [focusRequest, setFocusRequest] = useState(null); // { target, seq } | null

  function requestFocus(target) {
    setFocusRequest((previous) => ({ target, seq: (previous?.seq ?? 0) + 1 }));
  }

  // True only when the user had focus inside `containerRef` when the action
  // started AND focus is still there (or was dropped to <body> because the
  // focused element was removed or disabled). Never steals focus the user
  // deliberately moved elsewhere while an async operation was running.
  function canRestoreFocus(hadFocus, containerRef) {
    if (!hadFocus) return false;
    const active = document.activeElement;
    return !active || active === document.body || Boolean(containerRef.current?.contains(active));
  }

  useEffect(() => {
    if (!focusRequest) return;
    const { target } = focusRequest;
    if (target.startsWith('entry:')) {
      // A history entry's own Reverse button (it is re-enabled by this render).
      historyReverseRefs.current.get(target.slice('entry:'.length))?.focus();
      return;
    }
    const refs = {
      add: addButtonRef,
      remove: removeButtonRef,
      addSave: addSaveRef,
      removeSave: removeSaveRef,
      history: historyHeadingRef
    };
    refs[target]?.current?.focus();
  }, [focusRequest]);

  // The notice is position: fixed, so on its own it covers content and any
  // keyboard-focused control scrolled underneath it. While it is shown,
  // publish how much of the viewport bottom it occupies (its real, wrapping
  // height plus the bottom bar beneath it); the stylesheet turns that into
  // scroll-padding and page padding so focus and content stay clear of it.
  useEffect(() => {
    const notice = undoNoticeRef.current;
    if (!undoToast || !notice) return undefined;
    const root = document.documentElement;
    const update = () => {
      const covered = Math.ceil(window.innerHeight - notice.getBoundingClientRect().top);
      root.style.setProperty('--undo-clearance', `${Math.max(0, covered) + 8}px`);
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(notice);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--undo-clearance');
    };
  }, [undoToast]);

  // The over-removal dialog opens on Cancel: the safe choice, so a
  // stray Enter or Space cannot confirm a destructive removal.
  useEffect(() => {
    if (overRemoveWarning) overRemoveCancelRef.current?.focus();
  }, [overRemoveWarning]);

  // Expiry: runs only while nothing is interacting with the notice and no
  // reversal is in flight. Leaving the notice restarts the FULL duration.
  const undoPaused = undoInteraction.hover || undoInteraction.focus || reversingId !== null;
  useEffect(() => {
    if (!undoToast || undoPaused) return undefined;
    const timer = setTimeout(() => setUndoToast(null), UNDO_TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [undoToast, undoPaused]);

  // A removed notice cannot send mouseleave/blur, so reset what it tracked.
  useEffect(() => {
    if (!undoToast) setUndoInteraction({ hover: false, focus: false });
  }, [undoToast]);

  // The spoken confirmation of a reversal is transient.
  useEffect(() => {
    if (!announcement) return undefined;
    const timer = setTimeout(() => setAnnouncement(null), UNDO_TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [announcement]);

  function refreshAll() {
    productResource.reload();
    historyResource.reload();
  }

  function showUndoToast(eventId, message, origin) {
    undoOriginRef.current = origin;
    setAnnouncement(null);
    // A new object every time, so a second change restarts the expiry.
    setUndoToast({ eventId, message });
  }

  // Dismiss only closes the notice. If focus was inside it, that element is
  // about to disappear, so focus goes back to the action the user invoked.
  function dismissUndoToast() {
    if (undoNoticeRef.current?.contains(document.activeElement)) {
      requestFocus(undoOriginRef.current);
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
    const hadFocus = Boolean(addFormRef.current?.contains(document.activeElement));
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
        if (canRestoreFocus(hadFocus, addFormRef)) requestFocus('addSave');
        return;
      }

      const restore = canRestoreFocus(hadFocus, addFormRef);
      setAddSaving(false);
      closeAddForm();
      refreshAll();
      showUndoToast(result.event.id, `Stock increased by ${result.event.appliedQuantity}`, 'add');
      // The form (and the Save button that had focus) is gone: return focus
      // to Add Stock, so Remove Stock and then Undo are the next Tab stops.
      if (restore) requestFocus('add');
    } catch (err) {
      // The page and everything entered stay as they were; Save can be retried.
      console.error('Adding stock failed.', err);
      setAddSubmitError(STOCK_SAVE_FAILED);
      setAddSaving(false);
      if (canRestoreFocus(hadFocus, addFormRef)) requestFocus('addSave');
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
    const hadFocus = Boolean(removeFormRef.current?.contains(document.activeElement));

    try {
      const wouldOverRemove = await stockEventService.wouldOverRemove(id, quantity);
      if (wouldOverRemove) {
        setOverRemoveWarning({ quantity, comment: removeComment });
        return;
      }
    } catch (err) {
      console.error('Checking available stock failed.', err);
      setRemoveSubmitError(STOCK_CHECK_FAILED);
      return;
    }

    await commitRemoval(quantity, removeComment, hadFocus);
  }

  async function handleConfirmOverRemove() {
    if (!overRemoveWarning) return;
    const { quantity, comment } = overRemoveWarning;
    const hadFocus = Boolean(overRemoveRef.current?.contains(document.activeElement));
    setOverRemoveWarning(null);
    await commitRemoval(quantity, comment, hadFocus);
  }

  // Cancel (button or Escape) closes the dialog and returns focus to Save,
  // the control that opened it; the form and what was typed are untouched.
  function handleCancelOverRemove() {
    setOverRemoveWarning(null);
    requestFocus('removeSave');
  }

  // Escape closes the dialog only while focus is inside it, and is consumed
  // so it cannot also trigger anything behind it.
  function handleOverRemoveKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleCancelOverRemove();
    }
  }

  // `hadFocus`: focus was inside the remove form or the over-removal dialog
  // when the user started this action (see canRestoreFocus).
  async function commitRemoval(quantity, comment, hadFocus = false) {
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
        if (canRestoreFocus(hadFocus, removeFormRef)) requestFocus('removeSave');
        return;
      }

      const restore = canRestoreFocus(hadFocus, removeFormRef);
      setRemoveSaving(false);
      setShowRemoveForm(false);
      refreshAll();
      showUndoToast(result.event.id, `Stock reduced by ${result.event.appliedQuantity}`, 'remove');
      if (restore) requestFocus('remove');
    } catch (err) {
      console.error('Removing stock failed.', err);
      setRemoveSubmitError(STOCK_SAVE_FAILED);
      setRemoveSaving(false);
      if (canRestoreFocus(hadFocus, removeFormRef)) requestFocus('removeSave');
    }
  }

  // ---------------------------------------------------------------------------
  // Reversal (undo notice button AND per-history-entry "Reverse this action")
  // ---------------------------------------------------------------------------

  async function handleReverse(eventId, { fromNotice = false } = {}) {
    // Synchronous guard: state-based `disabled` only takes effect after a
    // render, so it alone cannot promise exactly one reversal per activation.
    if (reversingRef.current) return;
    reversingRef.current = true;

    // From the history list: did the user activate this entry's own button
    // with the keyboard (so it has focus)? That button is disabled while the
    // reversal runs and disappears once it succeeds, so focus must be placed
    // deliberately afterwards. See focusStillFree.
    const historyButton = historyReverseRefs.current.get(eventId);
    const hadHistoryFocus = !fromNotice && Boolean(historyButton) && document.activeElement === historyButton;
    const focusStillFree = () => {
      const active = document.activeElement;
      return !active || active === document.body || active === historyButton;
    };

    setReverseErrors((prev) => ({ ...prev, [eventId]: [] }));
    setReverseSubmitError(null);
    setReversingId(eventId);

    try {
      const result = await stockEventService.reverseEvent(eventId);
      if (result.errors.length > 0) {
        setReverseErrors((prev) => ({ ...prev, [eventId]: result.errors }));
        if (hadHistoryFocus && focusStillFree()) requestFocus(`entry:${eventId}`);
        return;
      }
      const restoreToHistory = hadHistoryFocus && focusStillFree();
      dismissUndoToast();
      refreshAll();
      // The entry's button is gone after a successful reversal: land on the
      // history heading (a stable point that is always there).
      if (restoreToHistory) requestFocus('history');
      // The stock number changes silently and the notice just disappears, so
      // say what happened. (A failure is already announced by its role=alert.)
      setAnnouncement(fromNotice ? 'Stock change undone.' : 'Stock change reversed.');
    } catch (err) {
      console.error('Reversing a stock event failed.', err);
      setReverseSubmitError(REVERSE_FAILED);
      if (hadHistoryFocus && focusStillFree()) requestFocus(`entry:${eventId}`);
    } finally {
      reversingRef.current = false;
      setReversingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const addInvalid = invalidStockFields(addErrors);
  const removeInvalid = invalidStockFields(removeErrors);

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
          <button
            type="button"
            ref={(element) => {
              if (element) historyReverseRefs.current.set(entry.id, element);
              else historyReverseRefs.current.delete(entry.id);
            }}
            onClick={() => handleReverse(entry.id)}
            disabled={reversingId !== null}
          >
            Reverse this action
          </button>
        )}
        {errors && errors.length > 0 && (
          <div role="alert" className="form-errors">
            <ul>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
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
      >
        {(product) => {
          if (product === null) {
            return (
              <>
                {/* Names the page; the alert states the problem. Not the same words twice. */}
                <h1>Product</h1>
                <NotFoundState
                  message="Product not found."
                  linkTo="/products"
                  linkLabel="Back to Products"
                />
              </>
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
                    <span className={`stock-badge stock-badge--${status === STOCK_STATUS.OUT ? 'out' : 'low'}`}>{status}</span>
                  ) : (
                    <span className="stock-badge stock-badge--ok">In stock</span>
                  )}
                </p>
                {hasPrice && <p>Selling price: {moneyFormat.format(product.sellingPrice)}</p>}
              </div>

              <div className="product-detail__actions">
                <button
                  ref={addButtonRef}
                  type="button"
                  onClick={showAddForm ? closeAddForm : openAddForm}
                  aria-expanded={showAddForm}
                  aria-controls="add-stock-form"
                >
                  Add Stock
                </button>
                <button
                  ref={removeButtonRef}
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
                {undoToast ? (
                  <div
                    className="undo-notice"
                    ref={undoNoticeRef}
                    onMouseEnter={() => setUndoInteraction((prev) => ({ ...prev, hover: true }))}
                    onMouseLeave={() => setUndoInteraction((prev) => ({ ...prev, hover: false }))}
                    onFocus={() => setUndoInteraction((prev) => ({ ...prev, focus: true }))}
                    // Moving Undo -> Dismiss fires blur then focus; the second
                    // event re-pauses before the expiry timer can start.
                    onBlur={() => setUndoInteraction((prev) => ({ ...prev, focus: false }))}
                  >
                    <span>{undoToast.message}</span>
                    {/* aria-disabled, not disabled, while reversing: a disabled
                        button loses keyboard focus in some browsers. The
                        reversal guard lives in handleReverse. */}
                    <button
                      type="button"
                      aria-disabled={reversingId !== null ? 'true' : undefined}
                      onClick={() => handleReverse(undoToast.eventId, { fromNotice: true })}
                    >
                      Undo
                    </button>
                    <button type="button" onClick={dismissUndoToast}>
                      Dismiss
                    </button>
                  </div>
                ) : (
                  announcement && <span className="visually-hidden">{announcement}</span>
                )}
              </div>
              {reverseSubmitError && <p role="alert">{reverseSubmitError}</p>}

              {showAddForm && (
                <form id="add-stock-form" ref={addFormRef} className="stock-form" onSubmit={handleAddSubmit}>
                  {addErrors.length > 0 && (
                    <div role="alert" id="add-form-errors" className="form-errors">
                      <ul>
                        {addErrors.map((message, index) => (
                          <li key={message} id={`add-form-error-${index}`}>
                            {message}
                          </li>
                        ))}
                      </ul>
                    </div>
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
                      aria-invalid={addInvalid.has('quantity') || undefined}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={addQuantity}
                      onChange={(e) => setAddQuantity(e.target.value)}
                      aria-describedby={describedBy(...fieldErrorIds('add-form', addErrors, 'quantity'))}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="add-cost">Cost per unit</label>
                    <input
                      id="add-cost"
                      aria-invalid={addInvalid.has('cost') || undefined}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={addCost}
                      onChange={(e) => {
                        costTouchedRef.current = true;
                        setAddCost(e.target.value);
                      }}
                      aria-describedby={describedBy(...fieldErrorIds('add-form', addErrors, 'cost'))}
                    />
                  </div>
                  <div className="stock-form__field">
                    <label htmlFor="add-purchase-date">Purchase date</label>
                    <input
                      id="add-purchase-date"
                      aria-invalid={addInvalid.has('purchaseDate') || undefined}
                      type="date"
                      value={addPurchaseDate}
                      onChange={(e) => setAddPurchaseDate(e.target.value)}
                      aria-describedby={describedBy(...fieldErrorIds('add-form', addErrors, 'purchaseDate'))}
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
                  <button ref={addSaveRef} type="submit" className="primary-action" disabled={addSaving}>
                    {addSaving ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}

              {showRemoveForm && (
                <form id="remove-stock-form" ref={removeFormRef} className="stock-form" onSubmit={handleRemoveSubmit}>
                  {removeErrors.length > 0 && (
                    <div role="alert" id="remove-form-errors" className="form-errors">
                      <ul>
                        {removeErrors.map((message, index) => (
                          <li key={message} id={`remove-form-error-${index}`}>
                            {message}
                          </li>
                        ))}
                      </ul>
                    </div>
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
                      aria-invalid={removeInvalid.has('quantity') || undefined}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={removeQuantity}
                      onChange={(e) => setRemoveQuantity(e.target.value)}
                      aria-describedby={describedBy(...fieldErrorIds('remove-form', removeErrors, 'quantity'))}
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
                  <button ref={removeSaveRef} type="submit" className="primary-action" disabled={removeSaving}>
                    {removeSaving ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}

              {overRemoveWarning && (
                // role="dialog", not "alertdialog": inline and non-modal. The page
                // behind stays visible and reachable, so focus is NOT trapped and
                // aria-modal is not set. It is named, described, takes focus on
                // Cancel when it opens (which is what makes screen readers announce
                // it) and closes on Escape while focus is inside it.
                <div
                  role="dialog"
                  className="over-remove-warning"
                  ref={overRemoveRef}
                  aria-label="Remove more than the available stock?"
                  aria-describedby="over-remove-message"
                  onKeyDown={handleOverRemoveKeyDown}
                >
                  <p id="over-remove-message">
                    Only {product.quantity} units are currently available. Remove{' '}
                    {overRemoveWarning.quantity} anyway?
                  </p>
                  <button ref={overRemoveCancelRef} type="button" onClick={handleCancelOverRemove}>
                    Cancel
                  </button>
                  <button type="button" onClick={handleConfirmOverRemove}>
                    Continue
                  </button>
                </div>
              )}

              <section className="product-detail__history" aria-busy={historyResource.isReloading}>
                <h2 ref={historyHeadingRef} tabIndex={-1}>
                  Stock History
                </h2>
                <ResourceView
                  resource={historyResource}
                  loadingMessage="Loading history…"
                  errorMessage="Couldn't load the stock history."
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
