// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/api/score', () => ({
  scoreDomain: vi.fn(),
}));

import { ScorePage } from '../ScorePage';
import { scoreDomain } from '@/api/score';

const scoreResponse = {
  domain: 'example.com',
  score: {
    expectedValue: 250,
    confidence: 0.8,
    recommended: true,
    suggestedBuyMax: 150,
    suggestedListPrice: 1000,
    weightedScore: 0.7,
    breakdown: {
      intrinsic: { score: 0.9, weight: 0.4 },
      commercial: { score: 0.5, weight: 0.6 },
    },
  },
  trademark: {
    verdict: 'clear',
    verifiedSources: ['USPTO'],
    partial: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ScorePage', () => {
  it('renders the lookup form', () => {
    render(<ScorePage />);
    expect(screen.getByPlaceholderText('example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /score/i })).toBeInTheDocument();
  });

  it('scores a domain on Enter and shows the result', async () => {
    vi.mocked(scoreDomain).mockResolvedValueOnce(scoreResponse as never);
    render(<ScorePage />);

    fireEvent.change(screen.getByPlaceholderText('example.com'), {
      target: { value: 'example.com' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('example.com'), { key: 'Enter' });

    await waitFor(() => expect(scoreDomain).toHaveBeenCalledWith('example.com'));
    expect(await screen.findByText('€250')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('€150')).toBeInTheDocument();
    expect(screen.getByText('€1000')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('(w: 40%)')).toBeInTheDocument();
  });

  it('renders the trademark verdict when present', async () => {
    vi.mocked(scoreDomain).mockResolvedValueOnce(scoreResponse as never);
    render(<ScorePage />);

    fireEvent.change(screen.getByPlaceholderText('example.com'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /score/i }));

    expect(await screen.findByText('clear')).toBeInTheDocument();
    expect(screen.getByText(/Verified sources: USPTO/)).toBeInTheDocument();
  });

  it('shows an error message when scoring fails', async () => {
    vi.mocked(scoreDomain).mockRejectedValueOnce(new Error('rate limited'));
    render(<ScorePage />);

    fireEvent.change(screen.getByPlaceholderText('example.com'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /score/i }));

    expect(await screen.findByText('rate limited')).toBeInTheDocument();
  });

  it('ignores empty input', async () => {
    render(<ScorePage />);
    fireEvent.click(screen.getByRole('button', { name: /score/i }));
    expect(scoreDomain).not.toHaveBeenCalled();
  });
});
