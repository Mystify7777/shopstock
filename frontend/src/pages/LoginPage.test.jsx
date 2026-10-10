import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppProvider } from '../contexts/AppContext.jsx';
import { AuthApiError, AuthNetworkError } from '../auth/authClient.js';
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

describe('LoginPage document title', () => {
  it('sets a sign-in title and restores the previous title when it closes', () => {
    document.title = 'Products \u2014 ShopStock';
    const authManager = { login: vi.fn() };
    const syncDrainer = { drain: vi.fn() };
    const { unmount } = render(
      <AppProvider services={{ authManager, syncDrainer }}>
        <LoginPage />
      </AppProvider>
    );
    expect(document.title).toBe('Sign in \u2014 ShopStock');
    unmount();
    expect(document.title).toBe('Products \u2014 ShopStock');
  });
});

function fill(username, password) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

afterEach(() => vi.restoreAllMocks());

describe('LoginPage', () => {
  it('renders a heading and labelled username/password fields', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Sign in to ShopStock' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('asks for both fields without calling login when either is empty', () => {
    const { authManager } = setup();
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your username and password.');
    expect(authManager.login).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('only flags the empty field as invalid', () => {
    setup();
    fill('shop', '');
    submit();
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits the trimmed username and the password exactly as typed', async () => {
    const { authManager } = setup();
    fill('  shop  ', ' pass word ');
    submit();
    await waitFor(() => expect(authManager.login).toHaveBeenCalledTimes(1));
    expect(authManager.login).toHaveBeenCalledWith('shop', ' pass word ');
  });

  it('drains the sync queue after a successful login (the documented 6D-4 seam)', async () => {
    const { syncDrainer } = setup();
    fill('shop', 'pw');
    submit();
    await waitFor(() => expect(syncDrainer.drain).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('failure messages (plain language, never raw errors)', () => {
    it.each([
      ['UNAUTHORIZED', 'Incorrect username or password.'],
      ['VALIDATION_ERROR', 'Incorrect username or password.'],
      ['RATE_LIMITED', 'Too many attempts. Wait a moment, then try again.'],
      ['INTERNAL_ERROR', "The server couldn't sign you in. Try again in a moment."],
    ])('%s -> "%s"', async (code, message) => {
      const { syncDrainer } = setup({}, vi.fn().mockRejectedValue(new AuthApiError(code, 'raw', 400)));
      fill('shop', 'pw');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('alert')).not.toHaveTextContent('raw');
      expect(syncDrainer.drain).not.toHaveBeenCalled();
    });

    it('a network failure says the server is unreachable', async () => {
      setup({}, vi.fn().mockRejectedValue(new AuthNetworkError(new Error('down'))));
      fill('shop', 'pw');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Can't reach the server. Check your connection and try again."
      );
    });

    it('an unexpected error gets a generic message and is logged', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      setup({}, vi.fn().mockRejectedValue(new TypeError('idb write failed')));
      fill('shop', 'pw');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong signing in. Try again.'
      );
      expect(consoleError).toHaveBeenCalled();
    });

    it('re-enables the form and keeps what was typed after a failure', async () => {
      setup({}, vi.fn().mockRejectedValue(new AuthApiError('UNAUTHORIZED', 'x', 401)));
      fill('shop', 'pw');
      submit();
      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
      expect(screen.getByLabelText('Username')).toHaveValue('shop');
      expect(screen.getByLabelText('Password')).toHaveValue('pw');
    });
  });

  it('disables the button and ignores repeat submits while signing in', async () => {
    let resolveLogin;
    const login = vi.fn(() => new Promise((r) => (resolveLogin = r)));
    setup({}, login);
    fill('shop', 'pw');
    submit();

    const busy = await screen.findByRole('button', { name: /signing in/i });
    expect(busy).toBeDisabled();
    fireEvent.submit(busy.closest('form'));
    expect(login).toHaveBeenCalledTimes(1);
    resolveLogin();
  });

  describe('why the screen is showing', () => {
    it('says nothing extra by default', () => {
      setup();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('explains an expired session', () => {
      setup({ reason: 'expired' });
      expect(screen.getByRole('status')).toHaveTextContent('Your session expired. Sign in again.');
    });

    it('explains a failed restoration', () => {
      setup({ reason: 'restore-failed' });
      expect(screen.getByRole('status')).toHaveTextContent(
        "We couldn't restore your session. Sign in to continue."
      );
    });
  });

  describe('optional way back to the app', () => {
    it('is not offered on the hard login gate', () => {
      setup();
      expect(screen.queryByRole('button', { name: /continue without signing in/i })).not.toBeInTheDocument();
    });

    it('is offered when onCancel is provided, and reassures that local data is untouched', () => {
      const onCancel = vi.fn();
      setup({ onCancel });
      expect(screen.getByText(/data on this device stays exactly as it is/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /continue without signing in/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
