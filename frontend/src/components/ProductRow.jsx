import { Link } from 'react-router-dom';
import { classifyStockStatus, needsAttention, STOCK_STATUS } from '../domain/classification/lowStock.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';

// One product in a list (Phase 7D): browse list, search results, closest
// matches and related products all render through this single row, so
// navigation and stock-status display are identical everywhere.
//
// The whole row is a real link to /products/:id (navigation is a link, not
// a button). It shows only what the product itself carries:
//   - name ("Unnamed product" for a photo-only product)
//   - quantity
//   - a visible stock-status label (text, never color alone)
//
// The unit is NOT shown: a Product stores only a `unitId`, and resolving
// that to a name would need a classification lookup this phase deliberately
// does not add. Same for category/location/tag names. Revisit after 7F.
//
// Stock status is computed by the existing domain function, never here.
// The low/out label is plain text, not a live region (7H Slice 3). A stock
// level is a state, not an event: it is part of the row link's accessible
// name (the words are read with the product), and a role="status" repeated on
// every row of a list, nested inside a link, would be a live region per item
// for content that is not changing in response to anything the user did.
// Changes the user causes (a stock edit) are announced by the page that made
// them, once.

const STATUS_MODIFIER = {
  [STOCK_STATUS.NORMAL]: 'ok',
  [STOCK_STATUS.LOW]: 'low',
  [STOCK_STATUS.OUT]: 'out'
};

/**
 * @param {{ product: object }} props
 */
export default function ProductRow({ product }) {
  const status = classifyStockStatus({
    quantity: product.quantity,
    globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    productThresholdOverride: product.lowStockThreshold,
    lowStockDisabled: product.lowStockDisabled
  });
  const attention = needsAttention(status);
  const statusClass = `product-row__status product-row__status--${STATUS_MODIFIER[status]}`;

  return (
    <li className="product-row">
      <Link to={`/products/${product.id}`} className="product-row__link">
        <span className="product-row__name">{product.name || 'Unnamed product'}</span>
        <span className="product-row__quantity">{product.quantity}</span>
        <span className={statusClass}>{attention ? status : 'In stock'}</span>
        <span className="product-row__chevron" aria-hidden="true">
          &rsaquo;
        </span>
      </Link>
    </li>
  );
}
