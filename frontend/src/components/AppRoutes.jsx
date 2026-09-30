import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './shell/AppShell.jsx';
import ProductListPage from '../pages/ProductListPage.jsx';
import ProductFormPage from '../pages/ProductFormPage.jsx';
import ProductDetailPage from '../pages/ProductDetailPage.jsx';
import NotFoundPage from '../pages/NotFoundPage.jsx';

/**
 * The application's route table, inside the shell. Router-agnostic (no
 * BrowserRouter here) so the whole composition can be tested under a
 * MemoryRouter; App.jsx supplies the real router.
 *
 * Route inventory:
 *   /                    -> redirect to /products
 *   /products            list
 *   /products/new        create form
 *   /products/:id        detail + stock operations
 *   /products/:id/edit   edit form
 *   *                    Not Found (inside the shell, with safe exits)
 *
 * @param {{ navItems?: Array<{label: string, to: string, end?: boolean}> }} props
 */
export default function AppRoutes({ navItems }) {
  return (
    <Routes>
      <Route element={<AppShell navItems={navItems} />}>
        <Route path="/" element={<Navigate to="/products" replace />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/new" element={<ProductFormPage />} />
        <Route path="/products/:id" element={<ProductDetailPage />} />
        <Route path="/products/:id/edit" element={<ProductFormPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
