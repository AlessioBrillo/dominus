// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/auth', () => ({
  verifyEmail: vi.fn(),
  requestRecovery: vi.fn(),
  confirmRecovery: vi.fn(),
}));

import { VerifyEmailPage } from '../VerifyEmailPage';
import { RecoverPage } from '../RecoverPage';
import { verifyEmail, requestRecovery, confirmRecovery } from '@/api/auth';

/**
 * The pages read the token from the query string, so the test needs a router
 * with a real location: the shared wrapper carries its own MemoryRouter and
 * a router cannot be nested.
 */
function renderAt(path: string, element: React.ReactElement, token?: string) {
  const queryClient = createTestQueryClient();
  const entry = token === undefined ? path : `${path}?token=${token}`;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redeems the token and shows the key', async () => {
    vi.mocked(verifyEmail).mockResolvedValue({
      tenantId: 'tenant-a',
      key: 'deadbeef',
      prefix: 'deadbeef',
      message: 'Save this key',
    });

    renderAt('/verify-email', <VerifyEmailPage />, 'a-token-with-enough-entropy');

    await waitFor(() => expect(screen.getByText('deadbeef')).toBeInTheDocument());
    expect(verifyEmail).toHaveBeenCalledWith('a-token-with-enough-entropy');
  });

  it('reports an invalid link', async () => {
    vi.mocked(verifyEmail).mockRejectedValue(new Error('The verification link is invalid'));

    renderAt('/verify-email', <VerifyEmailPage />, 'a-token-with-enough-entropy');

    await waitFor(() =>
      expect(screen.getByText('The verification link is invalid')).toBeInTheDocument(),
    );
  });

  it('reports a link without a token', async () => {
    renderAt('/verify-email', <VerifyEmailPage />);

    await waitFor(() =>
      expect(screen.getByText('The verification link is missing its token.')).toBeInTheDocument(),
    );
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});

describe('RecoverPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for a recovery link', async () => {
    vi.mocked(requestRecovery).mockResolvedValue({ sent: true });

    renderAt('/recover', <RecoverPage />);

    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send the recovery link' }));

    await waitFor(() => {
      expect(requestRecovery).toHaveBeenCalledWith('owner@example.com');
    });
    await waitFor(() =>
      expect(screen.getByText(/recovery link is on its way/)).toBeInTheDocument(),
    );
  });

  it('redeems the recovery token and shows the new key', async () => {
    vi.mocked(confirmRecovery).mockResolvedValue({
      tenantId: 'tenant-a',
      key: 'cafebabe',
      prefix: 'cafebabe',
      message: 'Save this key',
    });

    renderAt('/recover', <RecoverPage />, 'a-token-with-enough-entropy');

    await waitFor(() => expect(screen.getByText('cafebabe')).toBeInTheDocument());
    expect(confirmRecovery).toHaveBeenCalledWith('a-token-with-enough-entropy');
  });

  it('reports an invalid recovery link', async () => {
    vi.mocked(confirmRecovery).mockRejectedValue(new Error('The recovery link is invalid'));

    renderAt('/recover', <RecoverPage />, 'a-token-with-enough-entropy');

    await waitFor(() =>
      expect(screen.getByText('The recovery link is invalid')).toBeInTheDocument(),
    );
  });
});
