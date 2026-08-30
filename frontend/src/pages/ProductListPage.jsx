import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { classifyStockStatus, needsAttention } from '../domain/classification/lowStock.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition.js';

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
  const navigate = useNavigate();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

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
  const hasActiveFilters = Boolean(categoryId) || locationIds.length > 0 || tagIds.length > 0;

  const isSearching = debouncedQuery.trim().length > 0 || hasActiveFilters;

  const [searchResults, setSearchResults] = useState(null); // null = not searching
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

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

  // Search -- runs whenever the debounced query is non-empty OR any
  // filter is active (Phase 4C: "filters only, no text" is a valid
  // search case). Never calls the search service when both the query is
  // empty and no filter is active.
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
      .searchProducts(debouncedQuery, { categoryId, locationIds, tagIds })
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
  }, [debouncedQuery, isSearching, categoryId, locationIds, tagIds, productService]);

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
      {voiceError && <p role="alert">{voiceError}</p>}

      {filterOptionsError && <p role="alert">{filterOptionsError}</p>}

      <fieldset>
        <legend>Filters</legend>

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

        <fieldset>
          <legend>Locations</legend>
          {locationOptions.map((location) => (
            <label key={location.id}>
              <input
                type="checkbox"
                checked={locationIds.includes(location.id)}
                onChange={() => toggleLocationId(location.id)}
              />
              {location.name}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Tags</legend>
          {tagOptions.map((tag) => (
            <label key={tag.id}>
              <input
                type="checkbox"
                checked={tagIds.includes(tag.id)}
                onChange={() => toggleTagId(tag.id)}
              />
              {tag.name}
            </label>
          ))}
        </fieldset>

        {hasActiveFilters && (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </fieldset>

      {isSearching && searchLoading && <p>Searching&hellip;</p>}
      {isSearching && searchError && <p role="alert">{searchError}</p>}

      {isSearching && !searchLoading && !searchError && (
        displayedProducts.length === 0 ? (
          <p>No products match your search.</p>
        ) : (
          <ul>{displayedProducts.map(renderProductRow)}</ul>
        )
      )}

      {isSearching && !searchLoading && !searchError && searchResults &&
        !searchResults.hasExactMatch && searchResults.related.length > 0 && (
          <section>
            <h2>Related products</h2>
            <ul>{searchResults.related.map(renderProductRow)}</ul>
          </section>
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
