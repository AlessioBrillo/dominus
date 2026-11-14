// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

import { NotificationChannelsCard } from '../NotificationChannelsCard';
import { api } from '@/api/client';

const SETTINGS = {
  tenantId: 'tenant-a',
  email: 'alerts@example.com',
  hasWebhook: true,
  telegramChatId: null,
  enabled: true,
};

describe('NotificationChannelsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue(SETTINGS);
    vi.mocked(api.put).mockResolvedValue(SETTINGS);
    vi.mocked(api.post).mockResolvedValue({ channels: ['email'] });
  });

  it('shows the channels of the workspace', async () => {
    render(<NotificationChannelsCard />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByLabelText('Webhook URL')).toBeInTheDocument();
    });
    // The webhook URL is a secret: the field shows a placeholder, not the URL.
    expect(screen.getByPlaceholderText('•••••• (stored)')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/tenant/notifications');
  });

  it('saves the channels of the workspace', async () => {
    render(<NotificationChannelsCard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save channels' }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/tenant/notifications', {
        email: 'new@example.com',
        webhookUrl: null,
        telegramChatId: null,
      });
    });
  });

  it('sends a test alert to the channels', async () => {
    render(<NotificationChannelsCard />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Send a test' }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/tenant/notifications/test');
    });
  });
});
