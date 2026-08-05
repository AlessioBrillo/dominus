// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip.js';

describe('Tooltip primitives', () => {
  it('renders trigger and content when open by default', () => {
    render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Score details</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.getByText('Hover me')).toBeInTheDocument();
    // Radix renders the content twice: the visual popper plus a
    // visually-hidden accessible copy (role=tooltip) — assert presence,
    // not a single match.
    expect(screen.getAllByText('Score details').length).toBeGreaterThan(0);
  });
});
