import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginForm } from '../LoginForm.js';

vi.mock('../../hooks/useAuth.js', () => ({
  useAuth: () => ({ login: vi.fn() }),
}));

vi.mock('../../api/auth.js', () => ({
  verifyAndStoreKey: vi.fn().mockResolvedValue({ success: true }),
}));

describe('LoginForm', () => {
  it('renders API key input and authenticate button', () => {
    render(<LoginForm />);
    expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /authenticate/i })).toBeInTheDocument();
  });

  it('renders title and description', () => {
    render(<LoginForm />);
    expect(screen.getAllByText('DOMINUS').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Enter your API key to continue')).toBeInTheDocument();
  });
});
