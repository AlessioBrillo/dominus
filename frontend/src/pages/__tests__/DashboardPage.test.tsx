import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/api/dashboard', () => ({
  fetchDashboardStats: vi.fn(),
}));

vi.mock('@/api/candidates', () => ({
  runPipeline: vi.fn(),
}));

vi.mock('@/api/onboarding', () => ({
  getOnboardingState: vi.fn(),
}));

import { DashboardPage } from '../DashboardPage';
import { fetchDashboardStats } from '@/api/dashboard';
import { getOnboardingState } from '@/api/onboarding';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const mockData = {
  stats: {
    totalDomains: 10,
    keepCount: 5,
    dropCount: 3,
    repriceCount: 2,
    totalListValue: 15000,
    activeAlertCount: 1,
    recentAlerts: [
      {
        id: 1,
        domain: 'example.com',
        alertType: 'expiring',
        severity: 'warning',
        message: 'Expiring soon',
        acknowledgedAt: undefined,
        createdAt: '2026-06-01T00:00:00Z',
      },
    ],
    health: { status: 'ok', uptime: 3600, version: '0.4.0', timestamp: '2026-06-23T00:00:00Z' },
  },
  partialFailure: false,
  failureReasons: [],
};

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOnboardingState).mockResolvedValue({
      completedAt: null,
      currentStep: 'welcome',
      stepData: null,
    });
  });

  it('renders dashboard title', async () => {
    vi.mocked(fetchDashboardStats).mockResolvedValueOnce(mockData);
    render(<DashboardPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
  });

  it('renders stat cards', async () => {
    vi.mocked(fetchDashboardStats).mockResolvedValueOnce(mockData);
    render(<DashboardPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('10')).toBeInTheDocument();
    });
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders recent alerts', async () => {
    vi.mocked(fetchDashboardStats).mockResolvedValueOnce(mockData);
    render(<DashboardPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    });
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('shows error state', async () => {
    vi.mocked(fetchDashboardStats).mockRejectedValue(new Error('Failed to load'));
    render(<DashboardPage />, { wrapper: createWrapper() });

    await waitFor(
      () => {
        expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
