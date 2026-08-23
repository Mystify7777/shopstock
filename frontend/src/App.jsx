import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProductListPage from './pages/ProductListPage.jsx';
import ProductFormPage from './pages/ProductFormPage.jsx';

// Phase 2.4 vertical slice: minimal routing for Product list/create/edit
// only. No auth gate, no dashboard, no additional routes -- those are
// separate phases. The default route redirects to /products since it is
// currently the only real screen.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/products" replace />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/new" element={<ProductFormPage />} />
        <Route path="/products/:id/edit" element={<ProductFormPage />} />
      </Routes>
    </BrowserRouter>
  );
}
