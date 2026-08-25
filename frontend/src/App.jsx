import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProductListPage from './pages/ProductListPage.jsx';
import ProductFormPage from './pages/ProductFormPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';

// Phase 3: /products/:id is now the Product Detail + Stock Operations page.
// /products/:id/edit remains exclusively for metadata editing (name, notes).
// No auth gate, no dashboard, no additional routes -- those are separate
// phases. The default route redirects to /products since it is currently
// the only list screen.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/products" replace />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/new" element={<ProductFormPage />} />
        <Route path="/products/:id" element={<ProductDetailPage />} />
        <Route path="/products/:id/edit" element={<ProductFormPage />} />
      </Routes>
    </BrowserRouter>
  );
}
