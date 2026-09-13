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
import { createSyncQueueLifecycle } from './data/sync/syncQueueLifecycle.js';
import { createSyncEntryExecutor } from './data/sync/syncEntryExecutor.js';
import { createSyncDrainer } from './data/sync/syncDrainer.js';
import { triggerStartupSync, registerConnectivitySyncTrigger } from './data/sync/syncTriggers.js';
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
//             -> createSyncQueueLifecycle(db)
//               -> createSyncEntryExecutor({ apiClient })
//                 -> createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor })
//                   -> React application (via AppProvider)
//
// Dependency direction for the auth chain specifically (locked, Phase
// 6B2): apiClient depends on authManager; authManager depends on
// sessionStore and authClient. Never the reverse -- sessionStore and
// authClient know nothing about authManager, and authManager knows
// nothing about apiClient. See docs/ARCHITECTURE.md's Authentication
// section for the full contract this wiring implements.
//
// Dependency direction for the sync chain (locked, Phase 6C): syncDrainer
// depends on syncQueueLifecycle and syncEntryExecutor; syncEntryExecutor
// depends on apiClient (for HTTP) and createSyncRequest (for wire
// serialization). The sync chain never imports authManager/authClient/
// sessionStore directly -- apiClient is the sole bridge to authentication,
// confirmed by import inspection during Phase 6D-0's investigation.
//
// syncDrainer is exposed through AppContext for future UI consumers
// (Phase 6D-4+), but application-level triggers (startup/connectivity,
// Phase 6D-2/6D-3) are wired directly here, NOT routed through React
// context -- infrastructure calling infrastructure through the component
// tree would be an unnecessary indirection (locked during Phase 6D-0's
// review: triggers connect directly to authManager/syncDrainer).

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

const syncQueueLifecycle = createSyncQueueLifecycle(db);
const syncEntryExecutor = createSyncEntryExecutor({ apiClient });
const syncDrainer = createSyncDrainer({ syncQueueLifecycle, syncEntryExecutor });

// Phase 6D-2 — authenticated startup trigger: attempts session
// restoration, and drains ONLY if that restoration actually establishes
// an authenticated session (never merely because restoreSession()
// resolved -- see syncTriggers.js's own contract for the full
// reasoning). Fire-and-forget at the composition root: this must not
// block the initial React render.
void triggerStartupSync({ authManager, syncDrainer });

// Phase 6D-3 — connectivity-restoration trigger: calls drain() directly
// on every 'online' event, with no auth-readiness gating (see
// syncTriggers.js for why that's safe -- apiClient's existing
// 401-recovery path already handles an unauthenticated drain attempt
// correctly).
registerConnectivitySyncTrigger({ syncDrainer });

// Phase 6D-4 (login-triggered sync) is deferred -- no login UI exists
// yet to attach it to. See syncTriggers.js's header comment for the
// documented seam: a future login flow's success path should call
// syncDrainer.drain() directly, exactly as the startup trigger above
// does after a successful restoration.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider
      services={{
        productService,
        stockEventService,
        classificationRepository,
        authManager,
        apiClient,
        syncDrainer,
      }}
    >
      <App />
    </AppProvider>
  </React.StrictMode>
);
