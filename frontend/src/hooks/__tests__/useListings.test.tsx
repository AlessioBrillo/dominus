import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/listings', () => ({
  listListings: vi.fn(),
  getListing: vi.fn(),
  createListing: vi.fn(),
  updateListing: vi.fn(),
  deleteListing: vi.fn(),
  publishListing: vi.fn(),
  syncListings: vi.fn(),
  recordOffer: vi.fn(),
  acceptOffer: vi.fn(),
  declineOffer: vi.fn(),
}));

import {
  useListingsList,
  useListing,
  useCreateListing,
  useUpdateListing,
  useDeleteListing,
  usePublishListing,
  useSyncListings,
  useRecordOffer,
  useAcceptOffer,
  useDeclineOffer,
} from '../useListings';
import {
  listListings,
  getListing,
  createListing,
  updateListing,
  deleteListing,
  publishListing,
  syncListings,
  recordOffer,
  acceptOffer,
  declineOffer,
} from '@/api/listings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Listing } from '@/types/domain';

const mockListing: Listing = {
  id: 1,
  domain: 'example.com',
  marketplace: 'manual',
  listingUrl: null,
  priceEur: 1500,
  status: 'draft',
  scoringSnapshotJson: null,
  listedAt: null,
  expiresAt: null,
  notes: null,
  createdAt: '2026-06-25T00:00:00Z',
  updatedAt: '2026-06-25T00:00:00Z',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useListingsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns listings', async () => {
    vi.mocked(listListings).mockResolvedValueOnce({ listings: [mockListing] });
    const { result } = renderHook(() => useListingsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([mockListing]);
    expect(result.current.data).toHaveLength(1);
  });

  it('handles empty listings', async () => {
    vi.mocked(listListings).mockResolvedValueOnce({ listings: [] });
    const { result } = renderHook(() => useListingsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('handles fetch error', async () => {
    vi.mocked(listListings).mockRejectedValueOnce(new Error('Failed to fetch'));
    const { result } = renderHook(() => useListingsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useListing', () => {
  it('returns single listing with offers', async () => {
    vi.mocked(getListing).mockResolvedValueOnce({ listing: mockListing, offers: [] });
    const { result } = renderHook(() => useListing(1), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.listing).toEqual(mockListing);
    expect(result.current.data?.offers).toEqual([]);
  });
});

describe('useCreateListing', () => {
  it('triggers create mutation', async () => {
    vi.mocked(createListing).mockResolvedValueOnce({ listing: mockListing });
    const { result } = renderHook(() => useCreateListing(), { wrapper: createWrapper() });

    result.current.mutate({ domain: 'example.com' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createListing).toHaveBeenCalledOnce();
  });
});

describe('useUpdateListing', () => {
  it('triggers update mutation', async () => {
    vi.mocked(updateListing).mockResolvedValueOnce({ listing: mockListing });
    const { result } = renderHook(() => useUpdateListing(), { wrapper: createWrapper() });

    result.current.mutate({ id: 1, priceEur: 2000 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(updateListing).toHaveBeenCalledWith(1, { priceEur: 2000 });
  });
});

describe('useDeleteListing', () => {
  it('triggers delete mutation', async () => {
    vi.mocked(deleteListing).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteListing(), { wrapper: createWrapper() });

    result.current.mutate(1);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteListing).toHaveBeenCalledWith(1);
  });
});

describe('usePublishListing', () => {
  it('triggers publish mutation', async () => {
    vi.mocked(publishListing).mockResolvedValueOnce({
      listing: { ...mockListing, status: 'listed' },
    });
    const { result } = renderHook(() => usePublishListing(), { wrapper: createWrapper() });

    result.current.mutate(1);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(publishListing).toHaveBeenCalledWith(1);
  });
});

describe('useSyncListings', () => {
  it('triggers sync mutation', async () => {
    vi.mocked(syncListings).mockResolvedValueOnce({
      listings: [mockListing],
      offers: [],
      errors: [],
    });
    const { result } = renderHook(() => useSyncListings(), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(syncListings).toHaveBeenCalledOnce();
  });
});

describe('useRecordOffer', () => {
  it('triggers record offer mutation', async () => {
    vi.mocked(recordOffer).mockResolvedValueOnce({
      offer: {
        id: 1,
        listingId: 1,
        amountEur: 500,
        buyer: 'buyer',
        status: 'pending',
        receivedAt: new Date().toISOString(),
        respondedAt: null,
        notes: null,
      },
    });
    const { result } = renderHook(() => useRecordOffer(), { wrapper: createWrapper() });

    result.current.mutate({ listingId: 1, amount: 500, buyer: 'buyer' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(recordOffer).toHaveBeenCalledOnce();
  });
});

describe('useAcceptOffer', () => {
  it('triggers accept offer mutation', async () => {
    vi.mocked(acceptOffer).mockResolvedValueOnce({ status: 'accepted' });
    const { result } = renderHook(() => useAcceptOffer(), { wrapper: createWrapper() });

    result.current.mutate({ listingId: 1, offerId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(acceptOffer).toHaveBeenCalledWith(1, 1);
  });
});

describe('useDeclineOffer', () => {
  it('triggers decline offer mutation', async () => {
    vi.mocked(declineOffer).mockResolvedValueOnce({ status: 'declined' });
    const { result } = renderHook(() => useDeclineOffer(), { wrapper: createWrapper() });

    result.current.mutate({ listingId: 1, offerId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(declineOffer).toHaveBeenCalledWith(1, 1);
  });
});
