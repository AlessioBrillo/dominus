import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import {
  fetchWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  pollWatchlist,
} from '@/api/watchlist';
import type { WatchlistEntry } from '@/api/watchlist';
import { toast } from 'sonner';

export function useWatchlistList() {
  return useQuery({
    queryKey: queryKeys.watchlist.list(),
    queryFn: fetchWatchlist,
    staleTime: 30_000,
  });
}

export function useAddToWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ domain, notes }: { domain: string; notes?: string }) =>
      addToWatchlist(domain, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all });
      toast.success('Domain added to watchlist');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useRemoveFromWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => removeFromWatchlist(domain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all });
      toast.success('Removed from watchlist');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function usePollWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: pollWatchlist,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all });
      toast.success(`Polled ${result.checked} domains, ${result.changed} changed`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export type { WatchlistEntry };
