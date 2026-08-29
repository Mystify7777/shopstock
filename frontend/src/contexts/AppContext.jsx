// Application composition root context.
//
// A tiny context that carries the already-constructed services down the
// tree so components never construct their own database/repository/service
// instances. This is not a DI framework -- it is one createContext with one
// value, wired once in main.jsx.
//
// Components consume via useAppContext(), never by importing
// createDatabase/createProductRepository/createProductService directly.

import { createContext, useContext } from 'react';

const AppContext = createContext(null);

/**
 * @param {{ children: React.ReactNode, services: object }} props
 *   services shape: { productService, stockEventService, classificationRepository }
 */
export function AppProvider({ children, services }) {
  return (
    <AppContext.Provider value={services}>
      {children}
    </AppContext.Provider>
  );
}

/**
 * @returns {{ productService: object, stockEventService: object, classificationRepository: object }}
 * @throws {Error} if called outside an AppProvider
 */
export function useAppContext() {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useAppContext() must be used within an AppProvider.');
  }
  return context;
}
