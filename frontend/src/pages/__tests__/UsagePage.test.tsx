// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/usage', () => ({
  fetchUsageHistory: vi.fn(),
}));

import { UsagePage } from '../UsagePage';
import { fetchUsageHistory } from '@/api/usage';

function usageEntry(
  feature: string,
  currentUsage: number,
  limitValue: number | null,
  plan: string,
): unknown {
  return {
    feature,
    currentUsage,
    limitValue,
    remaining: limitValue === null ? null : limitValue - currentUsage,
    isOverLimit: limitValue !== null && currentUsage > limitValue,
    plan,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  };
}

const history = [
  {
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 10, 50, 'free'),
      api_calls: usageEntry('api_calls', 100, 1000, 'free'),
      domains_tracked: usageEntry('domains_tracked', 2, 25, 'free'),
    },
  },
  {
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 25, 50, 'free'),
      api_calls: usageEntry('api_calls', 250, 1000, 'free'),
      domains_tracked: usageEntry('domains_tracked', 4, 25, 'free'),
    },
  },
  {
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 40, 50, 'free'),
      api_calls: usageEntry('api_calls', 400, 1000, 'free'),
      domains_tracked: usageEntry('domains_tracked', 6, 25, 'free'),
    },
  },
  {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 45, 50, 'free'),
      api_calls: usageEntry('api_calls', 500, 1000, 'free'),
      domains_tracked: usageEntry('domains_tracked', 8, 25, 'free'),
    },
  },
  {
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 48, 50, 'free'),
      api_calls: usageEntry('api_calls', 600, 1000, 'free'),
      domains_tracked: usageEntry('domains_tracked', 10, 25, 'free'),
    },
  },
  {
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    plan: 'free',
    usage: {
      candidates_scored: usageEntry('candidates_scored', 120, 500, 'pro'),
      api_calls: usageEntry('api_calls', 5, 10000, 'pro'),
      domains_tracked: usageEntry('domains_tracked', 0, 250, 'pro'),
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UsagePage', () => {
  it('renders the current-month gauges and the monthly history chart', async () => {
    vi.mocked(fetchUsageHistory).mockResolvedValueOnce(history as never);
    render(<UsagePage />, { wrapper: createWrapper() });

    expect(await screen.findByText('Candidates scored')).toBeInTheDocument();
    expect(screen.getByText('API calls')).toBeInTheDocument();
    expect(screen.getByText('Domains tracked')).toBeInTheDocument();
    expect(screen.getByText('120 / 500')).toBeInTheDocument();
    expect(screen.getByText('5 / 10000')).toBeInTheDocument();
    expect(screen.getByText('0 / 250')).toBeInTheDocument();
    expect(screen.getByTestId('usage-history-chart')).toBeInTheDocument();
  });

  it('shows skeletons while loading', () => {
    vi.mocked(fetchUsageHistory).mockReturnValueOnce(new Promise(() => {}));
    render(<UsagePage />, { wrapper: createWrapper() });

    expect(screen.queryByText('Candidates scored')).not.toBeInTheDocument();
  });

  it('shows the error message when the request fails', async () => {
    vi.mocked(fetchUsageHistory).mockRejectedValueOnce(new Error('Failed to load usage'));
    render(<UsagePage />, { wrapper: createWrapper() });

    expect(await screen.findByText('Failed to load usage')).toBeInTheDocument();
  });

  it('shows an empty state when there is no history', async () => {
    vi.mocked(fetchUsageHistory).mockResolvedValueOnce([] as never);
    render(<UsagePage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No usage history')).toBeInTheDocument());
  });
});
