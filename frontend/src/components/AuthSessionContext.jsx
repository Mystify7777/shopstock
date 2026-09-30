import { createContext, useContext } from 'react';

// Carries the auth session view (see hooks/useAuthSession.js) from
// AuthGate down to the shell, so shell pieces can show a notice or a
// sign-out control without owning any auth logic.

const AuthSessionContext = createContext(null);

export const AuthSessionProvider = AuthSessionContext.Provider;

/**
 * @returns {ReturnType<import('../hooks/useAuthSession.js').useAuthSession>}
 * @throws {Error} if called outside an AuthGate / AuthSessionProvider
 */
export function useAuthSessionContext() {
  const value = useContext(AuthSessionContext);
  if (value === null) {
    throw new Error('useAuthSessionContext() must be used within an AuthGate.');
  }
  return value;
}
