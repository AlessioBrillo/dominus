import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/api/candidates', () => ({
  fetchCandidates: vi.fn(),
  fetchRuns: vi.fn(),
  runPipeline: vi.fn(),
  deleteCandidate: vi.fn(),
}));

import { CandidatesPage } from '../CandidatesPage';
import { fetchCandidates, fetchRuns } from '@/api/candidates';
import { createWrapper } from '@/hooks/__tests__/test-utils';

describe('CandidatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce([]);
    vi.mocked(fetchRuns).mockResolvedValueOnce([]);
    render(<CandidatesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Candidates')).toBeInTheDocument();
    });
  });

  it('shows empty state when no candidates', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce([]);
    vi.mocked(fetchRuns).mockResolvedValueOnce([]);
    render(<CandidatesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/Run a pipeline to generate candidates/i)).toBeInTheDocument();
    });
  });

  it('renders candidate list', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce([
      {
        id: 1,
        domain: 'test.com',
        tld: 'com',
        source: 'manual',
        status: 'new',
        createdAt: '2026-06-01T00:00:00Z',
      },
      {
        id: 2,
        domain: 'test2.com',
        tld: 'com',
        source: 'keyword',
        status: 'scored',
        createdAt: '2026-06-02T00:00:00Z',
      },
    ]);
    vi.mocked(fetchRuns).mockResolvedValueOnce([]);
    render(<CandidatesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('test.com')).toBeInTheDocument();
    });
    expect(screen.getByText('test2.com')).toBeInTheDocument();
  });

  it('renders run pipeline button', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce([]);
    vi.mocked(fetchRuns).mockResolvedValueOnce([]);
    render(<CandidatesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Run Pipeline')).toBeInTheDocument();
    });
  });
});
