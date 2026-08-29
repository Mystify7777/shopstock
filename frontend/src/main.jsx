import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { createDatabase } from './data/db/schema.js';
import { createProductRepository } from './data/repositories/productRepository.js';
import { createClassificationRepository } from './data/repositories/classificationRepository.js';
import { createStockEventRepository } from './data/repositories/stockEventRepository.js';
import { createProductService } from './services/productService.js';
import { createStockEventService } from './services/stockEventService.js';
import { AppProvider } from './contexts/AppContext.jsx';

// Composition root: this is the one place application dependencies are
// constructed and wired together. Everything below this point receives
// already-built services via AppContext -- no component, page, or service
// constructs its own database or repository.
//
//   createDatabase()
//     -> createProductRepository(db)
//     -> createClassificationRepository(db)
//       -> createProductService(productRepository, classificationRepository)
//     -> createStockEventRepository(db)
//       -> createStockEventService(stockEventRepository, productRepository)
//         -> React application (via AppProvider)

const db = createDatabase();
const productRepository = createProductRepository(db);
const classificationRepository = createClassificationRepository(db);
const stockEventRepository = createStockEventRepository(db);
const productService = createProductService(productRepository, classificationRepository);
const stockEventService = createStockEventService(stockEventRepository, productRepository);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider services={{ productService, stockEventService, classificationRepository }}>
      <App />
    </AppProvider>
  </React.StrictMode>
);
