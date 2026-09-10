import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { createDatabase } from './data/db/schema.js';
import { createProductRepository } from './data/repositories/productRepository.js';
import { createClassificationRepository } from './data/repositories/classificationRepository.js';
import { createStockEventRepository } from './data/repositories/stockEventRepository.js';
import { createProductService } from './services/productService.js';
import { createStockEventService } from './services/stockEventService.js';
import { createSessionStore } from './auth/sessionStore.js';
import { createAuthClient } from './auth/authClient.js';
import { createAuthManager } from './auth/authManager.js';
import { createApiClient } from './auth/apiClient.js';
import { AppProvider } from './contexts/AppContext.jsx';

// Composition root: this is the one place application dependencies are
// constructed and wired together. Everything below this point receives
// already-built services via AppContext -- no component, page, or service
// constructs its own database, repository, or auth instance.
//
//   createDatabase()
//     -> createProductRepository(db)
//     -> createClassificationRepository(db)
//       -> createProductService(productRepository, classificationRepository)
//     -> createStockEventRepository(db)
//       -> createStockEventService(stockEventRepository, productRepository)
//     -> createSessionStore(db)
//       -> createAuthClient(baseUrl)
//         -> createAuthManager({ sessionStore, authClient })
//           -> createApiClient({ authManager, baseUrl })
//             -> React application (via AppProvider)
//
// Dependency direction for the auth chain specifically (locked, Phase
// 6B2): apiClient depends on authManager; authManager depends on
// sessionStore and authClient. Never the reverse -- sessionStore and
// authClient know nothing about authManager, and authManager knows
// nothing about apiClient. See docs/ARCHITECTURE.md's Authentication
// section for the full contract this wiring implements.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

const db = createDatabase();
const productRepository = createProductRepository(db);
const classificationRepository = createClassificationRepository(db);
const stockEventRepository = createStockEventRepository(db);
const productService = createProductService(productRepository, classificationRepository);
const stockEventService = createStockEventService(stockEventRepository, productRepository);

const sessionStore = createSessionStore(db);
const authClient = createAuthClient(API_BASE_URL);
const authManager = createAuthManager({ sessionStore, authClient });
const apiClient = createApiClient({ authManager, baseUrl: API_BASE_URL });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider
      services={{
        productService,
        stockEventService,
        classificationRepository,
        authManager,
        apiClient,
      }}
    >
      <App />
    </AppProvider>
  </React.StrictMode>
);
