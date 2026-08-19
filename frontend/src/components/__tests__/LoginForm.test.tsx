// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '../LoginForm.js';

vi.mock('../../hooks/useAuth.js', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('../../api/auth.js', () => ({
  verifyAndStoreKey: vi.fn().mockResolvedValue({ success: true }),
  getSsoStatus: mockGetSsoStatus,
  startSsoLogin: mockStartSsoLogin,
}));

const { mockLogin, mockGetSsoStatus, mockStartSsoLogin } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockGetSsoStatus: vi.fn(),
  mockStartSsoLogin: vi.fn(),
}));

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockGetSsoStatus.mockResolvedValue({ available: false, session: null });
  vi.restoreAllMocks();
});

describe('LoginForm', () => {
  it('renders API key input and authenticate button', () => {
    render(<LoginForm />);
    expect(screen.getByPlaceholderText('API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /authenticate/i })).toBeInTheDocument();
  });

  it('renders title and description', () => {
    render(<LoginForm />);
    expect(screen.getByText('DOMINUS')).toBeInTheDocument();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
    expect(screen.getByText('Enter your API key to access the dashboard')).toBeInTheDocument();
  });

  it('shows an error and skips login when the key is empty', async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

    expect(await screen.findByText('API key is required')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('logs in with a trimmed key', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: '  sk-123  ' } });
    fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('sk-123'));
  });

  it('shows the login error message on failure', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid API key'));
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

    expect(await screen.findByText('Invalid API key')).toBeInTheDocument();
  });

  it('shows a fallback message for unknown failures', async () => {
    mockLogin.mockRejectedValueOnce('nope');
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
  });

  it('shows a loading state while authenticating', async () => {
    const { promise } = deferred();
    mockLogin.mockReturnValueOnce(promise);
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: 'sk-123' } });
    fireEvent.click(screen.getByRole('button', { name: /authenticate/i }));

    const button = await screen.findByRole('button', { name: /authenticating/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the SSO button when SSO is configured and redirects on click (ADR-0062)', async () => {
    mockGetSsoStatus.mockResolvedValue({
      available: true,
      session: { authenticated: false, sub: null, tenantId: null, role: null },
    });
    render(<LoginForm />);

    const button = await screen.findByRole('button', { name: /sign in with sso/i });
    fireEvent.click(button);
    expect(mockStartSsoLogin).toHaveBeenCalledTimes(1);
  });

  it('hides the SSO button when SSO is not configured (community edition)', async () => {
    render(<LoginForm />);
    await waitFor(() => expect(mockGetSsoStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /sign in with sso/i })).not.toBeInTheDocument();
  });

  it('surfaces the sso_error from the OIDC callback redirect', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?sso_error=authentication_failed' },
      writable: true,
    });
    render(<LoginForm />);
    expect(await screen.findByText(/single sign-on failed/i)).toBeInTheDocument();
  });
});
