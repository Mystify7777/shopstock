import { useAuthSession, AUTH_PHASE } from '../hooks/useAuthSession.js';
import { AuthSessionProvider } from './AuthSessionContext.jsx';
import LoginPage from '../pages/LoginPage.jsx';

/**
 * The authentication presentation boundary (Phase 7B). Decides which of
 * three things to show and nothing else -- all auth mechanics live in
 * authManager, observed through useAuthSession:
 *
 *   restoring                  loading screen (no flash of login)
 *   login (no usable session)  login screen, in place: it is not a route,
 *                              so a deep link or refresh keeps its URL
 *   authenticated / limited    the app (children), with the session
 *                              exposed to the shell via context
 *
 * In the `limited` phase the user may open the login screen on top of the
 * app. The app stays mounted (just hidden) so in-progress page state
 * survives a cancelled or completed sign-in.
 *
 * Local data is available in every phase where the app is shown; this
 * component never clears or hides Dexie data.
 */
export default function AuthGate({ children }) {
  const session = useAuthSession();
  const { phase, reason, loginOpen, closeLogin } = session;

  if (phase === AUTH_PHASE.RESTORING) {
    return (
      <div className="auth-screen">
        <p role="status">Loading ShopStock&hellip;</p>
      </div>
    );
  }

  if (phase === AUTH_PHASE.LOGIN) {
    return <LoginPage reason={reason} />;
  }

  return (
    <>
      {loginOpen && <LoginPage onCancel={closeLogin} />}
      <div hidden={loginOpen}>
        <AuthSessionProvider value={session}>{children}</AuthSessionProvider>
      </div>
    </>
  );
}
