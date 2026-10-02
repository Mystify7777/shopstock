import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './shell/AppShell.jsx';
import ProductListPage from '../pages/ProductListPage.jsx';
import ProductFormPage from '../pages/ProductFormPage.jsx';
import ProductDetailPage from '../pages/ProductDetailPage.jsx';
import NotFoundPage from '../pages/NotFoundPage.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import ClassificationsPage from '../pages/ClassificationsPage.jsx';
import { CLASSIFICATION_TYPES, classificationPath } from './classificationTypes.js';

/**
 * The application's route table, inside the shell. Router-agnostic (no
 * BrowserRouter here) so the whole composition can be tested under a
 * MemoryRouter; App.jsx supplies the real router.
 *
 * Route inventory:
 *   /                    Dashboard
 *   /products            list
 *   /products/new        create form
 *   /products/:id        detail + stock operations
 *   /products/:id/edit   edit form
 *   /classifications                  -> redirect to /classifications/categories
 *   /classifications/categories       management (also /locations, /tags, /units)
 *   *                    Not Found (inside the shell, with safe exits). An
 *                        unknown classification type, e.g.
 *                        /classifications/widgets, lands here too.
 *
 * @param {{ navItems?: Array<{label: string, to: string, end?: boolean}> }} props
 */
export default function AppRoutes({ navItems }) {
  return (
    <Routes>
      <Route element={<AppShell navItems={navItems} />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/new" element={<ProductFormPage />} />
        <Route path="/products/:id" element={<ProductDetailPage />} />
        <Route path="/products/:id/edit" element={<ProductFormPage />} />
        <Route
          path="/classifications"
          element={<Navigate to={classificationPath(CLASSIFICATION_TYPES[0].slug)} replace />}
        />
        {CLASSIFICATION_TYPES.map(({ type, slug }) => (
          // key={type}: switching tabs must not reuse the previous type's
          // page state (open edit boxes, notices, etc.).
          <Route
            key={type}
            path={classificationPath(slug)}
            element={<ClassificationsPage key={type} type={type} />}
          />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
