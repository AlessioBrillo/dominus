import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listBids,
  placeBid,
  resolveBid,
  type PlaceBidRequest,
  type ResolveBidRequest,
} from '@/api/bids';
import { queryKeys } from './query-keys';
import type { Bid } from '@/types/domain';

export function useBidsList(status?: string) {
  return useQuery({
    queryKey: queryKeys.bids.list(),
    queryFn: () => listBids(status),
    staleTime: 10_000,
    select: (data: { bids: Bid[] }) => data.bids,
  });
}

export function usePlaceBid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PlaceBidRequest) => placeBid(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bids.all });
    },
  });
}

export function useResolveBid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ResolveBidRequest) => resolveBid(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bids.all });
    },
  });
}

export type { Bid };
