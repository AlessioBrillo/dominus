// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/auth', () => ({
  registerTenant: vi.fn(),
}));

import { SignupPage } from '../SignupPage';
import { registerTenant } from '@/api/auth';

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a tenant and reveals the one-time API key', async () => {
    vi.mocked(registerTenant).mockResolvedValue({
      tenantId: 'tenant-abc',
      key: 'deadbeef',
      prefix: 'deadbeef',
      message: 'Save this key — it will not be shown again.',
    });

    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.type(screen.getByPlaceholderText('Name'), 'Alessio');
    await userEvent.type(screen.getByPlaceholderText('Email (optional)'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText('deadbeef')).toBeInTheDocument());
    expect(registerTenant).toHaveBeenCalledWith({ name: 'Alessio', email: 'a@example.com' });
  });

  it('surfaces validation failures', async () => {
    vi.mocked(registerTenant).mockRejectedValue(new Error('Name is required'));

    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText('Name is required')).toBeInTheDocument());
    expect(registerTenant).not.toHaveBeenCalled();
  });
});
