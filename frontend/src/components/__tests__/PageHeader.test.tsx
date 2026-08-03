// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '../PageHeader.js';

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Candidates" />);
    expect(screen.getByText('Candidates')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<PageHeader title="Candidates" subtitle="Review pipeline output" />);
    expect(screen.getByText('Review pipeline output')).toBeInTheDocument();
  });

  it('omits subtitle when absent', () => {
    render(<PageHeader title="Candidates" />);
    expect(screen.queryByText('Review pipeline output')).not.toBeInTheDocument();
  });

  it('renders actions when provided', () => {
    render(<PageHeader title="Candidates" actions={<button>New run</button>} />);
    expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument();
  });

  it('omits actions when absent', () => {
    render(<PageHeader title="Candidates" />);
    expect(screen.queryByRole('button', { name: 'New run' })).not.toBeInTheDocument();
  });
});
