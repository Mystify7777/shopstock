import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import ResourceView from '../components/ResourceView.jsx';
import { summarizeInventory, toActivityEntry } from '../domain/dashboard/dashboardSummary.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';
import { ADD_STOCK_INTENT } from '../navigation/addStockIntent.js';
import { STOCK_STATUS } from '../domain/classification/lowStock.js';

// Dashboard (Phase 7C, route "/").
//
// Everything shown is derived from existing authoritative data: active
// products (summarizeInventory) and recent stock events
// (stockEventService.getRecentActivity). Deliberately NOT shown: inventory
// cost, profit, total units, charts, sync metrics -- see
// domain/dashboard/dashboardSummary.js for why.
//
// Two independent data sections (inventory, recent activity), each with its
// own loading / error / retry, so one failing never blanks the other. The
// Add Product link and the search box need no data and always render.

const RECENT_ACTIVITY_LIMIT = 10;
const ATTENTION_ROWS_PER_GROUP = 5;

// Presentation-only formatting. The expected selling value is shown in rupees
// (redesign R4): the symbol is a fixed presentation choice, not a currency
// setting, and the amount itself is unchanged.
const numberFormat = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}

function productName(product) {
  return typeof product.name === 'string' && product.name.trim() !== ''
    ? product.name.trim()
    : 'Unnamed product';
}

// Which shared badge each attention group wears. The words come from the same
// domain labels the Product List uses, so "Low Stock" reads identically in both.
const ATTENTION_BADGE = {
  out: { modifier: 'out', label: STOCK_STATUS.OUT },
  low: { modifier: 'low', label: STOCK_STATUS.LOW }
};

function AttentionGroup({ title, products, count, filterValue }) {
  if (count === 0) return null;
  const badge = ATTENTION_BADGE[filterValue];

  return (
    <div className="dashboard__group">
      <h3>
        {title} ({count})
      </h3>
      <ul className="dashboard__list">
        {products.slice(0, ATTENTION_ROWS_PER_GROUP).map((product) => (
          <li key={product.id} className="dashboard__row dashboard__row--stacked dashboard__row--card">
            <Link to={`/products/${product.id}`} className="touch-link dashboard__row-name">
              <span className="text-truncate">{productName(product)}</span>
            </Link>
            <div className="dashboard__row-line">
              {/* Quantity first and largest, then the shared status badge (text, never color
                  alone). Neither is interactive; the only control on this line is Add stock. */}
              <span className="dashboard__row-detail dashboard__row-detail--nowrap">
                <span className="dashboard__qty">{product.quantity}</span>{' '}
                <span className={`badge badge--${badge.modifier}`}>{badge.label}</span>
              </span>
              {/* A sibling link, never nested in the name link. It only navigates: the stock
                  change itself is made (and queued, and undoable) on the product page. The
                  hidden suffix gives each link a unique name that still contains "Add stock". */}
              <Link to={`/products/${product.id}`} state={ADD_STOCK_INTENT} className="touch-link">
                Add stock <span className="visually-hidden">for {productName(product)}</span>
              </Link>
            </div>
          </li>
        ))}
      </ul>
      <Link to={`/products?stockStatus=${filterValue}`} className="touch-link">
        View all {count} in Products
      </Link>
    </div>
  );
}

export default function DashboardPage() {
  const { productService, stockEventService } = useAppContext();
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState('');

  const inventory = useAsyncResource(
    async () =>
      summarizeInventory(await productService.listProducts(), {
        globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD
      }),
    [productService]
  );

  const activity = useAsyncResource(async () => {
    const [events, products] = await Promise.all([
      stockEventService.getRecentActivity(RECENT_ACTIVITY_LIMIT),
      // includeArchived: an event can belong to a product archived since.
      productService.listProducts({ includeArchived: true })
    ]);
    const names = new Map(products.map((product) => [product.id, productName(product)]));
    return events.map((event) => ({
      ...toActivityEntry(event),
      productName: names.get(event.productId) ?? 'Unknown product'
    }));
  }, [productService, stockEventService]);

  function handleSearch(event) {
    event.preventDefault();
    const text = searchText.trim();
    navigate(text ? `/products?q=${encodeURIComponent(text)}` : '/products');
  }

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h1>Dashboard</h1>
        <Link to="/products/new" className="primary-action-link touch-link">
          Add Product
        </Link>
      </div>

      <form role="search" onSubmit={handleSearch} className="dashboard__search">
        <label htmlFor="dashboard-search">Search products</label>
        <input
          id="dashboard-search"
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button type="submit">Search</button>
      </form>

      <section aria-labelledby="dashboard-attention-heading">
        <h2 id="dashboard-attention-heading">Needs attention</h2>
        <ResourceView
          resource={inventory}
          loadingMessage="Checking stock levels…"
          errorMessage="Couldn't check your stock levels."
        >
          {(summary) =>
            summary.lowStockCount + summary.outOfStockCount === 0 ? (
              <p>Nothing needs attention.</p>
            ) : (
              <>
                <AttentionGroup
                  title="Out of stock"
                  products={summary.outOfStock}
                  count={summary.outOfStockCount}
                  filterValue="out"
                />
                <AttentionGroup
                  title="Low stock"
                  products={summary.lowStock}
                  count={summary.lowStockCount}
                  filterValue="low"
                />
              </>
            )
          }
        </ResourceView>
      </section>

      <section aria-labelledby="dashboard-activity-heading">
        <h2 id="dashboard-activity-heading">Recently updated</h2>
        <ResourceView
          resource={activity}
          loadingMessage="Loading recent activity…"
          errorMessage="Couldn't load recent activity."
        >
          {(entries) =>
            entries.length === 0 ? (
              <p>No stock activity yet.</p>
            ) : (
              <ul className="dashboard__list">
                {entries.map((entry) => (
                  <li key={entry.id} className="dashboard__row dashboard__row--stacked dashboard__row--card">
                    <Link to={`/products/${entry.productId}`} className="touch-link dashboard__row-name">
                      <span className="text-truncate">{entry.productName}</span>
                    </Link>
                    {/* Title line above, quieter detail line below. The colon is kept for
                        assistive technology ("Dettol: Added 20 ...") but not shown, and the
                        visual separator is hidden from it. */}
                    <span className="dashboard__row-meta">
                      <span className="visually-hidden">: </span>
                      {entry.direction === 'added' ? 'Added' : 'Removed'} {entry.amount}
                      {entry.isReversal ? ' (reversal)' : ''}
                      <span aria-hidden="true"> · </span>
                      <time dateTime={entry.recordedAt}>{formatTime(entry.recordedAt)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </ResourceView>
      </section>

      <section aria-labelledby="dashboard-inventory-heading">
        <h2 id="dashboard-inventory-heading">Inventory</h2>
        <ResourceView
          resource={inventory}
          loadingMessage="Loading inventory…"
          errorMessage="Couldn't load your inventory."
        >
          {(summary) =>
            summary.totalProducts === 0 ? (
              <p>No products yet. Add your first product to get started.</p>
            ) : (
              <>
                <dl className="dashboard__stats">
                  <div>
                    <dt>Products</dt>
                    <dd>{summary.totalProducts}</dd>
                  </div>
                  <div>
                    <dt>Low stock</dt>
                    <dd>{summary.lowStockCount}</dd>
                  </div>
                  <div>
                    <dt>Out of stock</dt>
                    <dd>{summary.outOfStockCount}</dd>
                  </div>
                  {summary.expectedSellingValue && (
                    <div>
                      <dt>Expected selling value</dt>
                      <dd>
                        <span className="dashboard__currency">₹</span>
                        {numberFormat.format(summary.expectedSellingValue.total)}
                      </dd>
                    </div>
                  )}
                </dl>
                {summary.expectedSellingValue && summary.expectedSellingValue.unpricedCount > 0 && (
                  <p>
                    {summary.expectedSellingValue.unpricedCount}{' '}
                    {summary.expectedSellingValue.unpricedCount === 1 ? 'product has' : 'products have'} no
                    selling price and {summary.expectedSellingValue.unpricedCount === 1 ? 'is' : 'are'} not
                    included in this value.
                  </p>
                )}
              </>
            )
          }
        </ResourceView>
      </section>
    </div>
  );
}
