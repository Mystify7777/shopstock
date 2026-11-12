// Redesign R7b: the login page's messages are the shared notices, it says what a
// trusted device can do (and nothing about offline use before the first
// sign-in), and its actions are one full-width Sign in plus a quiet "continue
// without signing in". Credential handling, every failure message and the ARIA
// wiring are pinned by LoginPage.test.jsx and AuthGate.test.jsx, which pass
// unmodified.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppProvider } from '../contexts/AppContext.jsx';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';
import { AUTH_REASON } from '../hooks/useAuthSession.js';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';
import LoginPage from './LoginPage.jsx';

function setup(props = {}, loginImpl = vi.fn().mockResolvedValue(undefined)) {
  const authManager = { login: loginImpl };
  const syncDrainer = { drain: vi.fn().mockResolvedValue(undefined) };
  render(
    <AppProvider services={{ authManager, syncDrainer }}>
      <LoginPage {...props} />
    </AppProvider>
  );
  return { authManager, syncDrainer };
}
const fill = (u, p) => {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: u } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: p } });
};
const signIn = () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';
const OFFLINE_LINE = 'Works offline after you sign in once on this device.';

afterEach(() => vi.restoreAllMocks());

describe('the line under the title', () => {
  it('says what a trusted device can do, directly under the title and before the form', () => {
    setup();
    const line = screen.getByText(OFFLINE_LINE);
    expect(line).toHaveClass('login__intro');
    expect(line.tagName).toBe('P');
    expect(line).not.toHaveAttribute('role');
    const heading = screen.getByRole('heading', { name: 'Sign in to ShopStock' });
    const form = document.querySelector('form');
    expect(heading.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('makes no claim about offline use before the first sign-in: "offline" appears once, tied to "after you sign in"', () => {
    setup();
    const text = document.body.textContent;
    expect(text.match(/offline/gi)).toHaveLength(1);
    expect(text).toContain('after you sign in once on this device');
  });

  it('is not shown when sign-in is optional, where the existing explanation is shown instead', () => {
    setup({ onCancel: vi.fn() });
    expect(screen.queryByText(OFFLINE_LINE)).not.toBeInTheDocument();
    expect(
      screen.getByText('Sign in to resume syncing. The data on this device stays exactly as it is.')
    ).toHaveClass('login__intro');
  });
});

describe('session reasons are warning notices, in the same words', () => {
  it.each([
    [AUTH_REASON.EXPIRED, 'Your session expired. Sign in again.'],
    [AUTH_REASON.RESTORE_FAILED, "We couldn't restore your session. Sign in to continue."]
  ])('%s', (reason, text) => {
    setup({ reason });
    const notice = screen.getByRole('status');
    expect(notice).toHaveClass('notice', 'notice--warning');
    expect(notice).toHaveTextContent(text);
    expect(notice.tagName).toBe('P');
  });

  it('there is no status message when there is no reason', () => {
    setup();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('a failed attempt is the shared danger notice, with its message unchanged', () => {
  it.each([
    ['network', () => new AuthNetworkError('offline'), "Can't reach the server. Check your connection and try again."],
    ['rate limited', () => new AuthApiError('RATE_LIMITED', 'slow', 429), 'Too many attempts. Wait a moment, then try again.'],
    ['unauthorized', () => new AuthApiError('UNAUTHORIZED', 'no', 401), 'Incorrect username or password.'],
    ['validation', () => new AuthApiError('VALIDATION_ERROR', 'bad', 400), 'Incorrect username or password.'],
    ['other server error', () => new AuthApiError('INTERNAL_ERROR', 'oops', 500), "The server couldn't sign you in. Try again in a moment."]
  ])('%s', async (_name, makeError, message) => {
    setup({}, vi.fn().mockRejectedValue(makeError()));
    fill('shop', 'pw');
    signIn();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveAttribute('id', 'login-error');
    expect(alert.tagName).toBe('P');
    expect(alert).toHaveTextContent(message);
    expect(document.querySelector('.login__error')).toBeNull();
    // a failure about the attempt as a whole flags no field
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
  });

  it('an unexpected failure uses the same notice', async () => {
    const consoleError = captureConsoleError('Unexpected login failure:');
    setup({}, vi.fn().mockRejectedValue(new Error('boom')));
    fill('shop', 'pw');
    signIn();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Something went wrong signing in. Try again.');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('empty fields: the same notice, and only the empty fields are invalid and described by it', () => {
    setup();
    fill('shop', '');
    signIn();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Enter your username and password.');
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'login-error');
  });
});

describe('actions', () => {
  it('Sign in is the only primary action and a submit button', () => {
    setup({ onCancel: vi.fn() });
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveClass('primary-action');
    expect(button).toHaveAttribute('type', 'submit');
    expect(document.querySelectorAll('.primary-action')).toHaveLength(1);
  });

  it('there is no "continue without signing in" unless sign-in is optional', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Continue without signing in' })).not.toBeInTheDocument();
    expect(document.querySelector('.login__actions').querySelectorAll(INTERACTIVE)).toHaveLength(1);
  });

  it('"continue without signing in" is a quiet button that calls onCancel, and is the only other control', () => {
    const onCancel = vi.fn();
    setup({ onCancel });
    const actions = document.querySelector('.login__actions');
    const quiet = screen.getByRole('button', { name: 'Continue without signing in' });
    expect(quiet).toHaveClass('quiet-action');
    expect(quiet).toHaveAttribute('type', 'button');
    expect(actions.querySelectorAll(INTERACTIVE)).toHaveLength(2);
    for (const control of actions.querySelectorAll(INTERACTIVE)) expect(control.querySelector(INTERACTIVE)).toBeNull();
    fireEvent.click(quiet);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('both buttons are disabled while signing in, as before', async () => {
    let finish;
    setup({ onCancel: vi.fn() }, vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    fill('shop', 'pw');
    signIn();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Continue without signing in' })).toBeDisabled();
    finish();
  });
});

describe('the form itself is unchanged', () => {
  it('keeps its labelled fields, autofill hints and masked password, and still skips native validation', () => {
    setup();
    expect(document.querySelector('form')).toHaveAttribute('novalidate');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocapitalize', 'none');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(document.querySelectorAll('form input, form select, form textarea')).toHaveLength(2);
  });
});
