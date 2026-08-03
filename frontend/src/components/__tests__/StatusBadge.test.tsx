// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../StatusBadge.js';

describe('StatusBadge', () => {
  it.each([
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['pending', 'Pending'],
    ['keep', 'Keep'],
    ['drop', 'Drop'],
    ['reprice', 'Reprice'],
    ['sold', 'Sold'],
    ['expired', 'Expired'],
    ['renewed', 'Renewed'],
    ['listed', 'Listed'],
    ['draft', 'Draft'],
  ])('renders label for known status %s', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('falls back to the raw status for unknown values', () => {
    render(<StatusBadge status="mystery" />);
    expect(screen.getByText('mystery')).toBeInTheDocument();
  });
});
