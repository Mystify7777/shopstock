import { BrowserRouter } from 'react-router-dom';
import AuthGate from './components/AuthGate.jsx';
import AppRoutes from './components/AppRoutes.jsx';

// Application root (Phase 7B):
//
//   BrowserRouter
//     -> AuthGate     restoring | login | app
//        -> AppRoutes the route table, rendered inside the app shell
//
// The route table and the shell live in components/ (AppRoutes, shell/)
// so the whole composition is testable under a MemoryRouter; this file
// only adds the real browser router and the auth boundary.

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <AppRoutes />
      </AuthGate>
    </BrowserRouter>
  );
}
