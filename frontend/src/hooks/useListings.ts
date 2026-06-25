import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listListings,
  getListing,
  createListing as createListingApi,
  updateListing as updateListingApi,
  deleteListing as deleteListingApi,
  publishListing as publishListingApi,
  syncListings as syncListingsApi,
  recordOffer as recordOfferApi,
  acceptOffer as acceptOfferApi,
  declineOffer as declineOfferApi,
  type CreateListingRequest,
  type UpdateListingRequest,
  type RecordOfferRequest,
} from '@/api/listings';
import { queryKeys } from './query-keys';
import type { Listing, ListingOffer } from '@/types/domain';

export { queryKeys };

const listingsKeys = {
  all: ['listings'] as const,
  list: () => [...listingsKeys.all, 'list'] as const,
  detail: (id: number) => [...listingsKeys.all, 'detail', id] as const,
};

export function useListingsList(status?: string, marketplace?: string, domain?: string) {
  return useQuery({
    queryKey: [...listingsKeys.list(), status, marketplace, domain],
    queryFn: () => listListings(status, marketplace, domain),
    staleTime: 10_000,
    select: (data: { listings: Listing[] }) => data.listings,
  });
}

export function useListing(id: number) {
  return useQuery({
    queryKey: listingsKeys.detail(id),
    queryFn: () => getListing(id),
    staleTime: 10_000,
    enabled: id > 0,
  });
}

export function useCreateListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateListingRequest) => createListingApi(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useUpdateListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateListingRequest & { id: number }) =>
      updateListingApi(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useDeleteListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => deleteListingApi(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function usePublishListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => publishListingApi(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useSyncListings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => syncListingsApi(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useRecordOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ listingId, ...input }: RecordOfferRequest & { listingId: number }) =>
      recordOfferApi(listingId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useAcceptOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ listingId, offerId }: { listingId: number; offerId: number }) =>
      acceptOfferApi(listingId, offerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export function useDeclineOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ listingId, offerId }: { listingId: number; offerId: number }) =>
      declineOfferApi(listingId, offerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listingsKeys.all });
    },
  });
}

export type { Listing, ListingOffer };
