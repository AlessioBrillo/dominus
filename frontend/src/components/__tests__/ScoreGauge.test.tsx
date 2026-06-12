import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreGauge } from '../ScoreGauge.js';

describe('ScoreGauge', () => {
  it('renders label and decimal value', () => {
    render(<ScoreGauge value={0.75} label="Intrinsic" />);
    expect(screen.getByText('Intrinsic')).toBeInTheDocument();
    expect(screen.getByText('0.75')).toBeInTheDocument();
  });

  it('renders 0.00 for zero value', () => {
    render(<ScoreGauge value={0} label="Empty" />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('renders 1.00 for max value', () => {
    render(<ScoreGauge value={1} label="Full" />);
    expect(screen.getByText('1.00')).toBeInTheDocument();
  });

  it('applies green color for high scores (>= 0.7)', () => {
    const { container } = render(<ScoreGauge value={0.85} label="High" />);
    const bar = container.querySelector('[class*="bg-emerald"]');
    expect(bar).toBeTruthy();
  });

  it('applies amber color for medium scores (>= 0.4, < 0.7)', () => {
    const { container } = render(<ScoreGauge value={0.5} label="Medium" />);
    const bar = container.querySelector('[class*="bg-amber"]');
    expect(bar).toBeTruthy();
  });

  it('applies red color for low scores (< 0.4)', () => {
    const { container } = render(<ScoreGauge value={0.2} label="Low" />);
    const bar = container.querySelector('[class*="bg-red"]');
    expect(bar).toBeTruthy();
  });
});
