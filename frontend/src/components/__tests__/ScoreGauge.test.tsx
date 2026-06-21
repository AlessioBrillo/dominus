import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreGauge } from '../ScoreGauge.js';

describe('ScoreGauge', () => {
  it('renders label and value', () => {
    render(<ScoreGauge value={0.75} label="Intrinsic" />);
    expect(screen.getByText('Intrinsic')).toBeInTheDocument();
    expect(screen.getByText('0.750')).toBeInTheDocument();
  });

  it('renders 0.000 for zero value', () => {
    render(<ScoreGauge value={0} label="Empty" />);
    expect(screen.getByText('0.000')).toBeInTheDocument();
  });

  it('renders 1.000 for max value', () => {
    render(<ScoreGauge value={1} label="Full" />);
    expect(screen.getByText('1.000')).toBeInTheDocument();
  });

  it('applies success color for high scores (>= 70%)', () => {
    const { container } = render(<ScoreGauge value={0.85} label="High" />);
    const bar = container.querySelector('.bg-success');
    expect(bar).toBeTruthy();
  });

  it('applies warning color for medium scores (>= 40%, < 70%)', () => {
    const { container } = render(<ScoreGauge value={0.5} label="Medium" />);
    const bar = container.querySelector('.bg-warning');
    expect(bar).toBeTruthy();
  });

  it('applies danger color for low scores (< 40%)', () => {
    const { container } = render(<ScoreGauge value={0.2} label="Low" />);
    const bar = container.querySelector('.bg-danger');
    expect(bar).toBeTruthy();
  });
});
