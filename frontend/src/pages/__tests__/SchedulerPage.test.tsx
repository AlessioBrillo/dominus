// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/scheduler', () => ({
  fetchSchedulerStatus: vi.fn(),
  runSchedulerJob: vi.fn(),
}));

import { SchedulerPage } from '../SchedulerPage';
import { fetchSchedulerStatus, runSchedulerJob } from '@/api/scheduler';

const job = {
  name: 'backup_db',
  cron: '0 4 * * *',
  enabled: true,
  lastRunAt: '2026-07-01T04:00:00Z',
  nextRunAt: '2026-07-02T04:00:00Z',
  lastStatus: 'completed',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SchedulerPage', () => {
  it('renders page title and refresh action', async () => {
    vi.mocked(fetchSchedulerStatus).mockResolvedValueOnce([job]);
    render(<SchedulerPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Scheduler')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('shows skeletons while loading', () => {
    vi.mocked(fetchSchedulerStatus).mockReturnValueOnce(new Promise(() => {}));
    render(<SchedulerPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Scheduler')).toBeInTheDocument();
    expect(screen.queryByText('No scheduled jobs')).not.toBeInTheDocument();
  });

  it('shows an error card when the request fails', async () => {
    vi.mocked(fetchSchedulerStatus).mockRejectedValueOnce(new Error('scheduler down'));
    render(<SchedulerPage />, { wrapper: createWrapper() });

    expect(await screen.findByText('scheduler down')).toBeInTheDocument();
  });

  it('shows the empty state when no jobs are configured', async () => {
    vi.mocked(fetchSchedulerStatus).mockResolvedValueOnce([]);
    render(<SchedulerPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No scheduled jobs')).toBeInTheDocument());
  });

  it('renders a job row with cron, last and next run, and status', async () => {
    vi.mocked(fetchSchedulerStatus).mockResolvedValueOnce([job]);
    render(<SchedulerPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('backup db')).toBeInTheDocument());
    expect(screen.getByText(/Cron:/)).toBeInTheDocument();
    expect(screen.getByText('0 4 * * *')).toBeInTheDocument();
    expect(screen.getAllByText('Completed')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
  });

  it('runs a job when Run Now is clicked', async () => {
    vi.mocked(fetchSchedulerStatus).mockResolvedValueOnce([job]);
    vi.mocked(runSchedulerJob).mockResolvedValueOnce({ started: true });
    render(<SchedulerPage />, { wrapper: createWrapper() });

    const button = await screen.findByRole('button', { name: /run now/i });
    fireEvent.click(button);

    await waitFor(() => expect(runSchedulerJob).toHaveBeenCalledWith('backup_db'));
  });
});
