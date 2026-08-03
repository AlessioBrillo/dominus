// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricCard } from '../MetricCard.js';

describe('MetricCard', () => {
  it('renders label and value with default accent', () => {
    render(<MetricCard label="Expected value" value="€12.34" />);
    expect(screen.getByText('Expected value')).toBeInTheDocument();
    expect(screen.getByText('€12.34')).toBeInTheDocument();
    expect(screen.getByText('€12.34').className).toContain('text-text-primary');
  });

  it('applies a custom accent', () => {
    render(<MetricCard label="Risk" value="High" accent="text-danger" />);
    expect(screen.getByText('High').className).toContain('text-danger');
  });

  it('renders subtext when provided', () => {
    render(<MetricCard label="Value" value="1" subtext="from 12 comps" />);
    expect(screen.getByText('from 12 comps')).toBeInTheDocument();
  });

  it('omits subtext when not provided', () => {
    render(<MetricCard label="Value" value="1" />);
    expect(screen.queryByText('from 12 comps')).not.toBeInTheDocument();
  });
});
