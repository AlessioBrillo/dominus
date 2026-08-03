// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '../LoginForm.js';

vi.mock('../../hooks/useAuth.js', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('../../api/auth.js', () => ({
  verifyAndStoreKey: vi.fn().mockResolvedValue({ success: true }),
}));

const { mockLogin } = vi.hoisted(() => ({ mockLogin: vi.fn() }));

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

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
});
