// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';
import { ApiError } from '@/api/client';

vi.mock('@/api/keys', () => ({
  fetchApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import { ApiKeysCard } from '../ApiKeysCard';
import { fetchApiKeys, createApiKey, revokeApiKey } from '@/api/keys';

const key = {
  id: 3,
  name: 'ci-pipeline',
  prefix: 'dk_abc123',
  role: 'member' as const,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchApiKeys).mockResolvedValue([key]);
});

describe('ApiKeysCard', () => {
  it('lists keys by prefix, never the secret', async () => {
    render(<ApiKeysCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('ci-pipeline')).toBeVisible();
    expect(screen.getByText(/dk_abc123/)).toBeVisible();
    expect(screen.getByText('never used')).toBeVisible();
  });

  it('creates a key and shows the secret once', async () => {
    vi.mocked(createApiKey).mockResolvedValue({
      id: 4,
      name: 'new',
      prefix: 'dk_new',
      key: 'dk_new_FULL_SECRET',
      message: 'm',
    });
    render(<ApiKeysCard />, { wrapper: createWrapper() });
    await screen.findByText('ci-pipeline');

    await userEvent.type(screen.getByLabelText('Key name'), 'new');
    await userEvent.click(screen.getByRole('button', { name: 'admin' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(createApiKey).toHaveBeenCalledWith('new', 'admin');
    expect(await screen.findByLabelText('New API key')).toHaveValue('dk_new_FULL_SECRET');
    expect(screen.getByRole('status')).toHaveTextContent(/will not see it again/i);
  });

  it('requires a name', async () => {
    render(<ApiKeysCard />, { wrapper: createWrapper() });
    await screen.findByText('ci-pipeline');

    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(createApiKey).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Give the key a name');
  });

  it('explains a full plan', async () => {
    vi.mocked(createApiKey).mockRejectedValue(new ApiError(403, 'SEAT_LIMIT_EXCEEDED', 'x'));
    render(<ApiKeysCard />, { wrapper: createWrapper() });
    await screen.findByText('ci-pipeline');

    await userEvent.type(screen.getByLabelText('Key name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no room for another key/i);
  });

  it('revokes a key', async () => {
    vi.mocked(revokeApiKey).mockResolvedValue(undefined);
    render(<ApiKeysCard />, { wrapper: createWrapper() });

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke key ci-pipeline' }));

    expect(revokeApiKey).toHaveBeenCalledWith(3);
  });

  it('renders nothing where the server does not manage keys (404) or the caller is not admin (403)', async () => {
    vi.mocked(fetchApiKeys).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x'));
    const { container, unmount } = render(<ApiKeysCard />, { wrapper: createWrapper() });
    await vi.waitFor(() => expect(fetchApiKeys).toHaveBeenCalled());
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();

    vi.mocked(fetchApiKeys).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'x'));
    const second = render(<ApiKeysCard />, { wrapper: createWrapper() });
    await vi.waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });
});
