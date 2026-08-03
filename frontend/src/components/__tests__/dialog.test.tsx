// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog.js';

describe('Dialog primitives', () => {
  it('renders content, header, footer, title and description when open', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm deletion</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div>Body</div>
          <DialogFooter>
            <button>Cancel</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByText('Confirm deletion')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Hidden</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });
});
