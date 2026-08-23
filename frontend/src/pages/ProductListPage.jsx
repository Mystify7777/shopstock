import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { classifyStockStatus, needsAttention } from '../domain/classification/lowStock.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../../shared/constants.js';

/**
 * Minimal product list screen -- Phase 2.4 vertical slice.
 *
 * Loading / empty / populated states, an Add Product action, and
 * navigation into a product's edit form on row tap. Low-stock status is
 * computed via the existing domain function (classifyStockStatus) --
 * never recalculated here. No search, no filters, no classification
 * display, no stock actions -- those are later phases.
 */
export default function ProductListPage() {
  const { productService } = useAppContext();
  const navigate = useNavigate();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  if (loading) {
    return <p>Loading products&hellip;</p>;
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  return (
    <div>
      <h1>Products</h1>
      <button onClick={() => navigate('/products/new')}>Add Product</button>

      {products.length === 0 ? (
        <p>No products yet. Add your first product to get started.</p>
      ) : (
        <ul>
          {products.map((product) => {
            const status = classifyStockStatus({
              quantity: product.quantity,
              globalDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
              productThresholdOverride: product.lowStockThreshold,
              lowStockDisabled: product.lowStockDisabled
            });
            const lowStock = needsAttention(status);

            return (
              <li key={product.id}>
                <button onClick={() => navigate(`/products/${product.id}/edit`)}>
                  {product.name || 'Unnamed product'} &mdash; {product.quantity}
                  {lowStock && <span role="status"> ({status})</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
