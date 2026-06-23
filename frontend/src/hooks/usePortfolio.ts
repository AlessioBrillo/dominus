import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchPortfolio,
  rescorePortfolio,
  refreshVerdicts,
  type PortfolioListResponse,
  type RescoreResponse,
} from '@/api/portfolio';
import { queryKeys } from './query-keys';
import type { PortfolioEntry } from '@/types/domain';

export function usePortfolioList() {
  return useQuery({
    queryKey: queryKeys.portfolio.list(),
    queryFn: fetchPortfolio,
    staleTime: 15_000,
    select: (data: PortfolioListResponse) => data.portfolio,
  });
}

export function useRescorePortfolio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rescorePortfolio,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
    },
  });
}

export function useRefreshVerdicts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshVerdicts,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
    },
  });
}

export type { PortfolioEntry, PortfolioListResponse, RescoreResponse };
