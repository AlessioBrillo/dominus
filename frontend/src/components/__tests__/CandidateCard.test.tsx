import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CandidateCard } from '../CandidateCard';
import type { Candidate } from '@/types/domain';

const baseCandidate: Candidate = {
  id: 1,
  domain: 'example.com',
  tld: 'com',
  source: 'keyword',
  status: 'recommended',
  createdAt: '2024-01-01T00:00:00Z',
  scoreResult: {
    domain: 'example.com',
    expectedValue: 2500,
    confidence: 0.65,
    suggestedBuyMax: 1250,
    suggestedListPrice: 6250,
    bidRange: { conservative: 800, aggressive: 1500 },
    weightedScore: 0.7,
    recommended: true,
    scoredAt: '2024-01-01T00:00:00Z',
    breakdown: {
      intrinsic: { score: 0.8, weight: 0.3 },
      commercial: { score: 0.6, weight: 0.35 },
      market: { score: 0.7, weight: 0.25 },
      expiry: { score: 0.5, weight: 0.1 },
    },
  },
};

describe('CandidateCard', () => {
  it('renders domain name and expected value', () => {
    render(<CandidateCard candidate={baseCandidate} />);
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('€2500')).toBeInTheDocument();
  });

  it('renders recommended badge for recommended status', () => {
    render(<CandidateCard candidate={baseCandidate} />);
    expect(screen.getByText('recommended')).toBeInTheDocument();
  });

  it('shows buy button for recommended candidates when onBuy is provided', () => {
    render(<CandidateCard candidate={baseCandidate} onBuy={vi.fn()} />);
    expect(screen.getByRole('button', { name: /buy €1250/i })).toBeInTheDocument();
  });

  it('calls onBuy when buy dialog is confirmed', () => {
    const onBuy = vi.fn();
    render(<CandidateCard candidate={baseCandidate} onBuy={onBuy} />);
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }));
    expect(screen.getByText(/Purchase example/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Proceed'));
    expect(onBuy).toHaveBeenCalledWith('example.com');
  });

  it('shows dismiss button when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    render(<CandidateCard candidate={baseCandidate} onDismiss={onDismiss} />);
    const dismissButton = document.querySelector('button.text-text-muted');
    expect(dismissButton).toBeTruthy();
  });

  it('renders without score gracefully', () => {
    const unscored: Candidate = { ...baseCandidate, scoreResult: null };
    render(<CandidateCard candidate={unscored} />);
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.queryByText('€2500')).not.toBeInTheDocument();
  });
});
