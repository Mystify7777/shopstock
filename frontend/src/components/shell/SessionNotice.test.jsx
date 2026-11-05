// Redesign R2: SessionNotice keeps its words and its one control, and wears the
// shared notice styles. Only "Sign in" (session ended) is a control.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthSessionProvider } from '../AuthSessionContext.jsx';
import { AUTH_PHASE, AUTH_REASON } from '../../hooks/useAuthSession.js';
import SessionNotice from './SessionNotice.jsx';

function renderNotice(value) {
  const session = { phase: AUTH_PHASE.LIMITED, reason: null, openLogin: vi.fn(), logout: vi.fn(), ...value };
  const view = render(
    <AuthSessionProvider value={session}>
      <SessionNotice />
    </AuthSessionProvider>
  );
  return { session, view };
}

describe('SessionNotice', () => {
  it('offline: a neutral, non-interactive status that keeps its words', () => {
    const { view } = renderNotice({ reason: AUTH_REASON.OFFLINE });
    const el = view.container.querySelector('.session-notice--offline');
    expect(el).toHaveClass('notice', 'notice--neutral', 'session-notice');
    expect(el).toHaveAttribute('role', 'status');
    expect(el.textContent).toContain('Can\u2019t reach the server.');
    expect(el.textContent).toContain('your changes will sync when you\u2019re back online.');
    expect(el.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('session ended: a warning notice whose only control is a real Sign in button', () => {
    const { view, session } = renderNotice({ reason: AUTH_REASON.SESSION_ENDED });
    const el = view.container.querySelector('.session-notice--warning');
    expect(el).toHaveClass('notice', 'notice--warning', 'session-notice');
    expect(el).toHaveAttribute('role', 'status');
    expect(el.textContent).toContain('Your data on this device is safe');
    expect(el.querySelectorAll('button')).toHaveLength(1);
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(session.openLogin).toHaveBeenCalledTimes(1);
  });

  it('renders nothing outside the limited phase', () => {
    const { view } = renderNotice({ phase: AUTH_PHASE.AUTHENTICATED });
    expect(view.container).toBeEmptyDOMElement();
  });
});
