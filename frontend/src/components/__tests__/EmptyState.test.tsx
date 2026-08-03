// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../EmptyState.js';

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No candidates yet" />);
    expect(screen.getByText('No candidates yet')).toBeInTheDocument();
  });

  it('renders icon and description when provided', () => {
    render(
      <EmptyState
        icon={<span data-testid="icon">*</span>}
        title="Empty"
        description="Run a pipeline to generate candidates."
      />,
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByText('Run a pipeline to generate candidates.')).toBeInTheDocument();
  });

  it('omits icon and description when absent', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
    expect(screen.queryByText('Run a pipeline to generate candidates.')).not.toBeInTheDocument();
  });

  it('renders the action when provided', () => {
    render(<EmptyState title="Empty" action={<button>Start</button>} />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});
