import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));

import { SettingsPage } from '../SettingsPage';
import { api } from '@/api/client';
import { createWrapper } from '@/hooks/__tests__/test-utils';

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings sections', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: 'ok',
      uptime: 3600,
      version: '0.4.0',
      timestamp: '2026-06-23T00:00:00Z',
    });
    vi.mocked(api.get).mockResolvedValueOnce({ providers: [] });

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(screen.getByText('System Health')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
  });

  it('shows health info', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: 'ok',
      uptime: 3600,
      version: '0.4.0',
      timestamp: '2026-06-23T00:00:00Z',
    });
    vi.mocked(api.get).mockResolvedValueOnce({ providers: [] });

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('0.4.0')).toBeInTheDocument();
    });

    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('shows provider statuses', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: 'ok',
      uptime: 3600,
      version: '0.4.0',
      timestamp: '2026-06-23T00:00:00Z',
    });
    vi.mocked(api.get).mockResolvedValueOnce({
      providers: [
        { name: 'Google KW', configured: true, note: 'ok' },
        { name: 'NameBio', configured: false, note: 'no key' },
      ],
    });

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Google KW')).toBeInTheDocument();
    });
    expect(screen.getByText('NameBio')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('renders sign out button', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: 'ok',
      uptime: 3600,
      version: '0.4.0',
      timestamp: '2026-06-23T00:00:00Z',
    });
    vi.mocked(api.get).mockResolvedValueOnce({ providers: [] });

    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Sign Out')).toBeInTheDocument();
    });
  });
});
