// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/listings', () => ({
  listListings: vi.fn().mockResolvedValue({ listings: [] }),
  getListing: vi.fn(),
  createListing: vi.fn(),
  updateListing: vi.fn(),
  deleteListing: vi.fn(),
  publishListing: vi.fn(),
  syncListings: vi.fn(),
  recordOffer: vi.fn(),
  acceptOffer: vi.fn(),
  declineOffer: vi.fn(),
  getListingSettings: vi.fn(),
  updateListingSettings: vi.fn(),
}));

import { ListingPolicyCard } from '../ListingPolicyCard';
import { getListingSettings, updateListingSettings } from '@/api/listings';

const defaults = {
  pricePolicy: 'scoring' as const,
  basePriceEur: null,
  offerAutoDeclineBelowEur: null,
  offerCounterEur: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getListingSettings).mockResolvedValue({ settings: defaults });
  vi.mocked(updateListingSettings).mockResolvedValue({ settings: defaults });
});

describe('ListingPolicyCard', () => {
  it('renders the conservative defaults', async () => {
    render(<ListingPolicyCard />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /scoring price/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    // Base price input is disabled while the policy is 'scoring'.
    expect(screen.getByLabelText('Base price')).toBeDisabled();
  });

  it('enables the base price input when the fixed policy is selected', async () => {
    render(<ListingPolicyCard />, { wrapper: createWrapper() });

    const fixed = await screen.findByRole('button', { name: /my base price/i });
    fireEvent.click(fixed);

    await waitFor(() => expect(screen.getByLabelText('Base price')).toBeEnabled());
  });

  it('saves the policy with the entered values', async () => {
    vi.mocked(updateListingSettings).mockResolvedValue({
      settings: { ...defaults, pricePolicy: 'fixed', basePriceEur: 2500 },
    });
    render(<ListingPolicyCard />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: /my base price/i }));
    fireEvent.change(screen.getByLabelText('Base price'), { target: { value: '2500' } });
    fireEvent.change(screen.getByLabelText('Auto-decline below (€)'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));

    await waitFor(() =>
      expect(updateListingSettings).toHaveBeenCalledWith({
        pricePolicy: 'fixed',
        basePriceEur: 2500,
        offerAutoDeclineBelowEur: 100,
        offerCounterEur: null,
      }),
    );
  });

  it('refuses to save a fixed policy without a base price', async () => {
    render(<ListingPolicyCard />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: /my base price/i }));
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));

    await waitFor(() =>
      expect(updateListingSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ pricePolicy: 'fixed' }),
      ),
    );
    expect(updateListingSettings).not.toHaveBeenCalled();
  });

  it('loads saved settings into the form', async () => {
    vi.mocked(getListingSettings).mockResolvedValue({
      settings: {
        pricePolicy: 'fixed',
        basePriceEur: 1800,
        offerAutoDeclineBelowEur: 200,
        offerCounterEur: 1500,
      },
    });
    render(<ListingPolicyCard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByLabelText('Base price')).toHaveValue(1800));
    expect(screen.getByLabelText('Auto-decline below (€)')).toHaveValue(200);
    expect(screen.getByLabelText('Counter below (€)')).toHaveValue(1500);
    expect(screen.getByRole('button', { name: /my base price/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
