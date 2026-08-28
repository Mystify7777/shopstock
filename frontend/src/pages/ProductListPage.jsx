import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { classifyStockStatus, needsAttention } from '../domain/classification/lowStock.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';

const SEARCH_DEBOUNCE_MS = 450;

/**
 * Product list screen.
 *
 * Loading / empty / populated states, an Add Product action, and
 * navigation into a product's detail/stock page on row tap (Phase 3:
 * /products/:id, not the metadata edit form). Low-stock status is
 * computed via the existing domain function (classifyStockStatus) --
 * never recalculated here.
 *
 * Phase 4A: a search input, debounced ~450ms, delegates to
 * productService.searchProducts() when non-empty. When the search field
 * is empty, this page falls back to its normal, pre-existing
 * listProducts() behavior unchanged -- the search service is never
 * called for an empty query (per the approved Phase 4A contract).
 * Related results (Phase 4B), category/location/tag filter controls
 * (Phase 4C), and voice search (Phase 4D) are not implemented yet.
 */
export default function ProductListPage() {
  const { productService } = useAppContext();
  const navigate = useNavigate();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const isSearching = debouncedQuery.trim().length > 0;

  const [searchResults, setSearchResults] = useState(null); // null = not searching
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // Normal (non-search) product list -- unchanged from Phase 2.4/3.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await productService.listProducts();
        if (!cancelled) {
          setProducts(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [productService]);

  // Search -- only runs when the debounced query is non-empty. Never calls
  // the search service for an empty/whitespace-only query.
  useEffect(() => {
    if (!isSearching) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);

    productService
      .searchProducts(debouncedQuery)
      .then((result) => {
        if (cancelled) return;
        setSearchResults(result);
        setSearchLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setSearchError(err.message);
        setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, isSearching, productService]);

  if (loading) {
    return <p>Loading products&hellip;</p>;
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  function renderProductRow(product) {
    const status = classifyStockStatus({
      quantity: product.quantity,
      globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
      productThresholdOverride: product.lowStockThreshold,
      lowStockDisabled: product.lowStockDisabled
    });
    const lowStock = needsAttention(status);

    return (
      <li key={product.id}>
        <button onClick={() => navigate(`/products/${product.id}`)}>
          {product.name || 'Unnamed product'} &mdash; {product.quantity}
          {lowStock && <span role="status"> ({status})</span>}
        </button>
      </li>
    );
  }

  const displayedProducts = isSearching
    ? (searchResults ? searchResults.matches : [])
    : products;

  return (
    <div>
      <h1>Products</h1>
      <button onClick={() => navigate('/products/new')}>Add Product</button>

      <label htmlFor="product-search">Search</label>
      <input
        id="product-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search products…"
      />

      {isSearching && searchLoading && <p>Searching&hellip;</p>}
      {isSearching && searchError && <p role="alert">{searchError}</p>}

      {isSearching && !searchLoading && !searchError && (
        displayedProducts.length === 0 ? (
          <p>No products match your search.</p>
        ) : (
          <ul>{displayedProducts.map(renderProductRow)}</ul>
        )
      )}

      {!isSearching && (
        products.length === 0 ? (
          <p>No products yet. Add your first product to get started.</p>
        ) : (
          <ul>{products.map(renderProductRow)}</ul>
        )
      )}
    </div>
  );
}
