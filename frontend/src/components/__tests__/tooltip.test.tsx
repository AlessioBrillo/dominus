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
    expect(screen.getByText('Score details')).toBeInTheDocument();
  });
});
