// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

// The keys card has its own tests; keep this file's sequential api.get mocks stable.
vi.mock('@/components/ApiKeysCard', () => ({ ApiKeysCard: () => null }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));

import { SettingsPage } from '../SettingsPage';
import { api } from '@/api/client';
import { createWrapper } from '@/hooks/__tests__/test-utils';

/**
 * The queries are mocked BY PATH, not by call order: the effects of the
 * child components run before the effects of the page, so the order of the
 * calls is not the order of the source.
 */
function mockApi(
  providers: Array<{ name: string; configured: boolean; note?: string }> = [],
): void {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/health') {
      return {
        status: 'ok',
        uptime: 3600,
        version: '0.4.0',
        timestamp: '2026-06-23T00:00:00Z',
      };
    }
    if (path === '/providers/status') return { providers };
    if (path === '/tenant/notifications') {
      return {
        tenantId: 'tenant-a',
        email: null,
        hasWebhook: false,
        telegramChatId: null,
        enabled: true,
      };
    }
    return {};
  });
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings sections', async () => {
    mockApi();

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(screen.getByText('System Health')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
  });

  it('shows health info', async () => {
    mockApi();

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('0.4.0')).toBeInTheDocument();
    });

    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('shows provider statuses', async () => {
    mockApi([
      { name: 'Google KW', configured: true, note: 'ok' },
      { name: 'NameBio', configured: false, note: 'no key' },
    ]);

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Google KW')).toBeInTheDocument();
    });
    expect(screen.getByText('NameBio')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('renders the notification channels of the workspace', async () => {
    mockApi();

    render(<SettingsPage />, { wrapper: createWrapper() });

    // The card shows a skeleton while the channels are loading: wait for the
    // fields, not for the title (the skeleton carries it too).
    await waitFor(() => {
      expect(screen.getByLabelText('Webhook URL')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Telegram chat id')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders sign out button', async () => {
    mockApi();

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument();
    });
  });
});
