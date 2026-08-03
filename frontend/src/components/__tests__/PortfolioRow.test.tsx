// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PortfolioRow } from '../PortfolioRow.js';
import type { PortfolioEntry } from '@/types/domain';

const baseEntry: PortfolioEntry = {
  id: 1,
  domain: 'example.com',
  tld: 'com',
  acquiredAt: '2025-01-01T00:00:00Z',
  renewalDate: '2026-06-01T00:00:00Z',
  acquisitionCost: 12.5,
  renewalCost: 10,
  registrar: 'namecheap',
  currentScore: 0.75,
  suggestedListPrice: 2500,
  verdict: 'keep',
};

describe('PortfolioRow', () => {
  it('renders a full entry with all optional fields', () => {
    render(<PortfolioRow entry={baseEntry} />);
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('€12.50')).toBeInTheDocument();
    expect(
      screen.getByText(new Date(baseEntry.renewalDate).toLocaleDateString()),
    ).toBeInTheDocument();
    expect(screen.getByText('75')).toBeInTheDocument();
    expect(screen.getByText('€2500')).toBeInTheDocument();
    expect(screen.getByText('keep')).toBeInTheDocument();
  });

  it('falls back to em dashes when costs and score are missing', () => {
    const entry = {
      ...baseEntry,
      acquisitionCost: undefined,
      renewalDate: null,
      currentScore: undefined,
      suggestedListPrice: undefined,
    } as unknown as PortfolioEntry;
    render(<PortfolioRow entry={entry} />);
    expect(screen.getByText('€—')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('75')).not.toBeInTheDocument();
    expect(screen.queryByText('€2500')).not.toBeInTheDocument();
  });

  it.each([
    ['reprice', 'reprice'],
    ['drop', 'drop'],
    ['unknown', 'unknown'],
  ])('renders the verdict %s', (verdict, label) => {
    render(<PortfolioRow entry={{ ...baseEntry, verdict } as unknown as PortfolioEntry} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
