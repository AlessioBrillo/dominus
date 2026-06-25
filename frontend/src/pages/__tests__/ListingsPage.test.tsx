import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ListingsPage } from '../ListingsPage';
import type { Listing, MarketplaceName } from '@/types/domain';

const mkListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 1,
  domain: 'example.com',
  marketplace: 'manual' as MarketplaceName,
  listingUrl: null,
  priceEur: 1500,
  status: 'draft',
  scoringSnapshotJson: null,
  listedAt: null,
  expiresAt: null,
  notes: null,
  createdAt: '2026-06-25T00:00:00Z',
  updatedAt: '2026-06-25T00:00:00Z',
  ...overrides,
});

const draftListing = mkListing();
const listedListing = mkListing({
  id: 2,
  domain: 'test.io',
  marketplace: 'dan' as MarketplaceName,
  listingUrl: 'https://dan.com/listing/test-io',
  priceEur: 2500,
  status: 'listed',
  listedAt: '2026-06-24T00:00:00Z',
  createdAt: '2026-06-23T00:00:00Z',
  updatedAt: '2026-06-24T00:00:00Z',
});

vi.mock('@/api/listings', () => ({
  listListings: vi.fn<() => Promise<{ listings: Listing[] }>>(),
  createListing: vi.fn<() => Promise<{ listing: Listing }>>(),
  updateListing: vi.fn(),
  deleteListing: vi.fn<() => Promise<void>>(),
  publishListing: vi.fn<() => Promise<{ listing: Listing }>>(),
  syncListings: vi.fn<() => Promise<{ listings: Listing[]; offers: never[]; errors: never[] }>>(),
  getListing: vi.fn<() => Promise<{ listing: Listing; offers: never[] }>>(),
  recordOffer: vi.fn(),
  acceptOffer: vi.fn<() => Promise<{ status: string }>>(),
  declineOffer: vi.fn<() => Promise<{ status: string }>>(),
}));

import {
  listListings,
  createListing,
  publishListing,
  deleteListing,
  syncListings,
  getListing,
  acceptOffer,
  declineOffer,
} from '@/api/listings';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ListingsPage />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ListingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page title', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [] });
    renderPage();
    expect(screen.getByText('Listings')).toBeTruthy();
  });

  it('shows loading state', () => {
    vi.mocked(listListings).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByPlaceholderText('Domain')).toBeTruthy();
  });

  it('shows empty state', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No listings found/)).toBeTruthy();
    });
  });

  it('renders listing rows', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [draftListing, listedListing] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeTruthy();
      expect(screen.getByText('test.io')).toBeTruthy();
    });
  });

  it('shows error state', async () => {
    vi.mocked(listListings).mockRejectedValue(new Error('API error'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeTruthy();
    });
  });

  it('filters by status', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [draftListing, listedListing] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Draft'));
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.queryByText('test.io')).toBeNull();
  });

  it('creates a new listing', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [] });
    vi.mocked(createListing).mockResolvedValue({ listing: draftListing });
    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Domain')).toBeTruthy();
    });

    await userEvent.type(screen.getByPlaceholderText('Domain'), 'new-domain.com');
    await userEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(createListing).toHaveBeenCalledWith({
        domain: 'new-domain.com',
        marketplace: 'manual',
        price: undefined,
      });
    });
  });

  it('publishes a listing', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [draftListing] });
    vi.mocked(publishListing).mockResolvedValue({ listing: { ...draftListing, status: 'listed' } });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Publish'));
    await waitFor(() => {
      expect(publishListing).toHaveBeenCalledWith(1);
    });
  });

  it('shows offers dialog for a listing', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [listedListing] });
    vi.mocked(getListing).mockResolvedValue({
      listing: listedListing,
      offers: [
        {
          id: 1,
          listingId: 2,
          amountEur: 2000,
          buyer: 'buyer1',
          status: 'pending',
          receivedAt: '2026-06-25T00:00:00Z',
          respondedAt: null,
          notes: null,
        },
      ],
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('test.io')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Offers'));
    await waitFor(() => {
      expect(screen.getByText(/Offers for test.io/)).toBeTruthy();
    });
  });

  it('accepts an offer', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [listedListing] });
    const pendingOffer = {
      id: 1,
      listingId: 2,
      amountEur: 2000,
      buyer: 'buyer1',
      status: 'pending' as const,
      receivedAt: '2026-06-25T00:00:00Z',
      respondedAt: null,
      notes: null,
    };
    vi.mocked(getListing).mockResolvedValueOnce({
      listing: listedListing,
      offers: [pendingOffer],
    });
    vi.mocked(getListing).mockResolvedValueOnce({
      listing: listedListing,
      offers: [{ ...pendingOffer, status: 'accepted', respondedAt: '2026-06-25T01:00:00Z' }],
    });
    vi.mocked(acceptOffer).mockResolvedValue({ status: 'accepted' });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('test.io')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Offers'));
    await waitFor(() => {
      expect(screen.getByText(/Offers for test.io/)).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Accept'));
    await waitFor(() => {
      expect(acceptOffer).toHaveBeenCalledWith(2, 1);
    });
  });

  it('declines an offer', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [listedListing] });
    const pendingOffer = {
      id: 2,
      listingId: 2,
      amountEur: 1800,
      buyer: 'buyer2',
      status: 'pending' as const,
      receivedAt: '2026-06-25T02:00:00Z',
      respondedAt: null,
      notes: null,
    };
    vi.mocked(getListing).mockResolvedValueOnce({
      listing: listedListing,
      offers: [pendingOffer],
    });
    vi.mocked(getListing).mockResolvedValueOnce({
      listing: listedListing,
      offers: [{ ...pendingOffer, status: 'declined', respondedAt: '2026-06-25T03:00:00Z' }],
    });
    vi.mocked(declineOffer).mockResolvedValue({ status: 'declined' });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('test.io')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Offers'));
    await waitFor(() => {
      expect(screen.getByText(/Offers for test.io/)).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Decline'));
    await waitFor(() => {
      expect(declineOffer).toHaveBeenCalledWith(2, 2);
    });
  });

  it('deletes a listing', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [draftListing] });
    vi.mocked(deleteListing).mockResolvedValue(undefined);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('example.com')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByText(/Are you sure/)).toBeTruthy();
    });

    const confirmBtn = screen.getAllByText('Delete')[1] as HTMLElement;
    await userEvent.click(confirmBtn);
    await waitFor(() => {
      expect(deleteListing).toHaveBeenCalledWith(1);
    });
  });

  it('syncs listings', async () => {
    vi.mocked(listListings).mockResolvedValue({ listings: [draftListing, listedListing] });
    vi.mocked(syncListings).mockResolvedValue({
      listings: [draftListing, listedListing],
      offers: [],
      errors: [],
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Sync')).toBeTruthy();
    });

    await userEvent.click(screen.getByText('Sync'));
    await waitFor(() => {
      expect(syncListings).toHaveBeenCalledOnce();
    });
  });
});
