import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import ResourceView from '../components/ResourceView.jsx';
import ProductRow from '../components/ProductRow.jsx';
import { sortProductsByName } from '../domain/product/productOrdering.js';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition.js';

const SEARCH_DEBOUNCE_MS = 450;

// Phase 7C: the only values the ?stockStatus= URL parameter accepts, with
// the wording shown to the user while one is active. Anything else in the
// URL is ignored.
const STOCK_STATUS_PARAM_LABELS = {
  low: 'low stock products',
  out: 'out-of-stock products'
};

function parseStockStatusParam(value) {
  return typeof value === 'string' && Object.hasOwn(STOCK_STATUS_PARAM_LABELS, value) ? value : null;
}

/**
 * Product list screen.
 *
 * Loading / empty / populated states, an Add Product action, and
 * navigation into a product's detail/stock page from each row (Phase 3:
 * /products/:id, not the metadata edit form). Rows are rendered by
 * ProductRow, which computes stock status via the existing domain function
 * (classifyStockStatus) -- never recalculated here.
 *
 * Phase 4A: a search input, debounced ~450ms, delegates to
 * productService.searchProducts() when non-empty. When the search field
 * is empty AND no filters are active, this page falls back to its
 * normal, pre-existing listProducts() behavior unchanged -- the search
 * service is never called in that case (per the approved Phase 4A
 * contract, extended by Phase 4C for the filters-only case below).
 *
 * Phase 4B: a "Related products" section renders below closest matches
 * when searchResults.related is non-empty AND there was no exact match
 * (an exact match means the primary result set is already authoritative;
 * no empty "Related products" heading is ever rendered). Related rows
 * reuse the exact same row renderer as closest matches, so navigation
 * and low-stock indicator behavior are identical.
 *
 * Phase 4C: compact category (single-select) / location (multi-select) /
 * tag (multi-select) filter controls. Selecting any filter engages the
 * SAME search path as typing a query -- "filters only, no text" is a
 * valid, distinct case handled entirely by productService.searchProducts
 * (empty query + active filters), not by separate page-level branching.
 * Filter OPTIONS (the list of categories/locations/tags to choose from)
 * are loaded ONCE on mount from classificationRepository, independent of
 * the query/filter effect below -- selecting a filter must never
 * re-trigger a classification-options reload (Phase 4C locked contract).
 *
 * Phase 7C (dashboard compatibility seam): the page reads two optional URL
 * parameters -- ?q=<text> (initial search text) and ?stockStatus=low|out
 * (a stock-status filter) -- so the dashboard can link into it. They only
 * SEED existing state (and re-seed it if the URL changes while mounted);
 * typing and the filter controls still work exactly as before and do not
 * write back to the URL. An active stock-status filter is always shown in
 * words and can be cleared with the existing "Clear filters" button.
 *
 * Phase 7D (presentation; search/filter semantics unchanged): the header,
 * search and filter controls always render -- a slow or failed product load
 * only affects the list area, so search and filters stay usable. Product-
 * load and search failures offer Try again (search keeps the query and
 * filters; product-load also links to the Dashboard). Closest matches are
 * labelled when a text query has no exact match. The plain browse list and
 * filters-only results are shown in name order (productOrdering.js);
 * text-query results keep their Fuse relevance order. Filter groups with no
 * options are not rendered.
 *
 * Voice search (Phase 4D): an input adapter only -- a microphone button
 * beside the search field, present only when the browser supports the
 * Web Speech API. On a final transcript, it calls the SAME setQuery()
 * the text input already uses; nothing about debouncing, filters, or the
 * search pipeline is aware voice input exists. Absent entirely (not
 * disabled) when unsupported, so text search remains the only, fully
 * functional path on unsupported browsers/devices.
 */
export default function ProductListPage() {
  const { productService, classificationRepository } = useAppContext();
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const urlStockStatus = parseStockStatusParam(searchParams.get('stockStatus'));

  // Plain (non-search) product list. A resource, so a failed load can be
  // retried without a page reload.
  const productsResource = useAsyncResource(() => productService.listProducts(), [productService]);
  const browseProducts = useMemo(
    () => (productsResource.data ? sortProductsByName(productsResource.data) : []),
    [productsResource.data]
  );

  const [query, setQuery] = useState(urlQuery);
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const queryText = debouncedQuery.trim();

  // Voice search (Phase 4D) -- input adapter only. A final transcript
  // simply calls the same setQuery() the text input uses; the existing
  // debounce/search pipeline below is entirely unaware voice exists.
  const {
    isSupported: isVoiceSupported,
    isListening: isVoiceListening,
    error: voiceError,
    start: startVoiceSearch,
    stop: stopVoiceSearch
  } = useSpeechRecognition(setQuery);

  // Filter state -- mirrors Product's own field shapes directly
  // (categoryId singular, locationIds/tagIds arrays), per the Phase 4C
  // approved contract.
  const [categoryId, setCategoryId] = useState(null);
  const [locationIds, setLocationIds] = useState([]);
  const [tagIds, setTagIds] = useState([]);
  const [stockStatus, setStockStatus] = useState(urlStockStatus);

  const hasActiveFilters =
    Boolean(categoryId) || locationIds.length > 0 || tagIds.length > 0 || Boolean(stockStatus);
  const activeFilterCount =
    (categoryId ? 1 : 0) + locationIds.length + tagIds.length + (stockStatus ? 1 : 0);

  // Phase 7C: if the URL's parameters change while this page stays mounted
  // (e.g. browser back/forward between two /products?... URLs), re-seed the
  // state from them. On mount this sets the values already used above.
  useEffect(() => {
    setQuery(urlQuery);
    setStockStatus(urlStockStatus);
  }, [urlQuery, urlStockStatus]);

  const isSearching = queryText.length > 0 || hasActiveFilters;
  const [searchResults, setSearchResults] = useState(null); // null = not searching
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // Bumped by "Try again" to re-run the same search (same query + filters).
  const [searchAttempt, setSearchAttempt] = useState(0);

  // Filter options -- loaded ONCE on mount, independent of query/filter
  // state changes below. Selecting a category/location/tag must never
  // re-trigger this effect (Phase 4C locked contract).
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);
  const [tagOptions, setTagOptions] = useState([]);
  const [filterOptionsError, setFilterOptionsError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFilterOptions() {
      try {
        // classificationRepository.list() defaults to includeArchived:
        // false -- filter controls must never expose archived
        // classifications as selectable options (Phase 4C locked
        // contract). No special-casing needed; this is the default.
        const [categories, locations, tags] = await Promise.all([
          classificationRepository.list('category'),
          classificationRepository.list('location'),
          classificationRepository.list('tag')
        ]);
        if (!cancelled) {
          setCategoryOptions(categories);
          setLocationOptions(locations);
          setTagOptions(tags);
        }
      } catch (err) {
        if (!cancelled) {
          setFilterOptionsError(err.message);
        }
      }
    }

    loadFilterOptions();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // mount-only; see the comment above this effect.
  }, [classificationRepository]);

  // Search -- runs whenever the debounced query is non-empty OR any
  // filter is active (Phase 4C: "filters only, no text" is a valid
  // search case). Never calls the search service when both the query is
  // empty and no filter is active. A response that arrives after the
  // inputs changed is ignored (cancelled).
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
      .searchProducts(debouncedQuery, {
        categoryId,
        locationIds,
        tagIds,
        // Only present when set, so the filter object is unchanged otherwise.
        ...(stockStatus ? { stockStatus } : {})
      })
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
  }, [debouncedQuery, isSearching, categoryId, locationIds, tagIds, stockStatus, searchAttempt, productService]);

  function toggleLocationId(id) {
    setLocationIds((prev) =>
      prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]
    );
  }

  function toggleTagId(id) {
    setTagIds((prev) =>
      prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]
    );
  }

  function clearFilters() {
    setCategoryId(null);
    setLocationIds([]);
    setTagIds([]);
    setStockStatus(null);
  }

  // Text-query results keep their Fuse relevance order. Filters-only
  // results (empty query) have no relevance order, so they are shown by
  // name, like the browse list.
  const searchMatches = useMemo(() => {
    if (!searchResults) return [];
    return queryText.length > 0 ? searchResults.matches : sortProductsByName(searchResults.matches);
  }, [searchResults, queryText]);

  function renderSearchResults() {
    // searchResults === null while searching means the request has not
    // been answered yet (including the render before the effect runs).
    if (searchLoading || (searchResults === null && !searchError)) {
      return <p>Searching&hellip;</p>;
    }

    if (searchError) {
      return (
        <div role="alert" className="resource-error">
          <p>Couldn&rsquo;t run that search. Your search and filters are kept.</p>
          <p>{searchError}</p>
          <button type="button" onClick={() => setSearchAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      );
    }

    const showClosest = queryText.length > 0 && !searchResults.hasExactMatch && searchMatches.length > 0;
    const showRelated = !searchResults.hasExactMatch && searchResults.related.length > 0;

    return (
      <>
        {searchMatches.length === 0 ? (
          <p className="product-list__empty">No products match your search.</p>
        ) : (
          <>
            {showClosest && (
              <>
                <h2>Closest matches</h2>
                <p>No exact match for &ldquo;{queryText}&rdquo;.</p>
              </>
            )}
            <ul className="product-list__results">
              {searchMatches.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </ul>
          </>
        )}
        {showRelated && (
          <section>
            <h2>Related products</h2>
            <ul className="product-list__results">
              {searchResults.related.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  const hasFilterOptions =
    categoryOptions.length > 0 || locationOptions.length > 0 || tagOptions.length > 0;

  return (
    <div className="product-list">
      <div className="product-list__header">
        <h1>Products</h1>
        <Link to="/products/new" className="product-list__add">
          Add Product
        </Link>
      </div>

      <div className="product-list__search">
        <label htmlFor="product-search">Search</label>
        <div className="product-list__search-row">
          <input
            id="product-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
          />
          {isVoiceSupported && (
            <button
              type="button"
              aria-label="Search by voice"
              aria-pressed={isVoiceListening}
              onClick={isVoiceListening ? stopVoiceSearch : startVoiceSearch}
            >
              {isVoiceListening ? '🎤 Listening…' : '🎤'}
            </button>
          )}
        </div>
      </div>

      {voiceError && <p role="alert">{voiceError}</p>}
      {filterOptionsError && (
        <p role="alert">Couldn&rsquo;t load your filters. You can still browse and search.</p>
      )}

      {(hasFilterOptions || hasActiveFilters) && (
        <div className="product-list__filters">
          {categoryOptions.length > 0 && (
            <div className="product-list__category">
              <label htmlFor="filter-category">Category</label>
              <select
                id="filter-category"
                value={categoryId || ''}
                onChange={(e) => setCategoryId(e.target.value || null)}
              >
                <option value="">All categories</option>
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {locationOptions.length > 0 && (
            <fieldset className="chip-group">
              <legend>Locations</legend>
              <div className="chip-group__items">
                {locationOptions.map((location) => (
                  <label key={location.id} className="chip">
                    <input
                      type="checkbox"
                      className="chip__input"
                      checked={locationIds.includes(location.id)}
                      onChange={() => toggleLocationId(location.id)}
                    />
                    <span className="chip__label">{location.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {tagOptions.length > 0 && (
            <fieldset className="chip-group">
              <legend>Tags</legend>
              <div className="chip-group__items">
                {tagOptions.map((tag) => (
                  <label key={tag.id} className="chip">
                    <input
                      type="checkbox"
                      className="chip__input"
                      checked={tagIds.includes(tag.id)}
                      onChange={() => toggleTagId(tag.id)}
                    />
                    <span className="chip__label">{tag.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {hasActiveFilters && (
            <div className="product-list__active">
              <span>
                {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'} active
              </span>
              {stockStatus && <p>Showing {STOCK_STATUS_PARAM_LABELS[stockStatus]} only.</p>}
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      <div className="product-list__results-area">
        {isSearching ? (
          renderSearchResults()
        ) : (
          <>
            <ResourceView
              resource={productsResource}
              loadingMessage="Loading products…"
              errorMessage="Couldn't load your products."
              showDetail
            >
              {() =>
                browseProducts.length === 0 ? (
                  <p className="product-list__empty">No products yet. Add your first product to get started.</p>
                ) : (
                  <ul className="product-list__results">
                    {browseProducts.map((product) => (
                      <ProductRow key={product.id} product={product} />
                    ))}
                  </ul>
                )
              }
            </ResourceView>
            {productsResource.status === 'error' && (
              <p>
                <Link to="/">Go to Dashboard</Link>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
