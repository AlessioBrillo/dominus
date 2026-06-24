import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchPortfolio,
  rescorePortfolio,
  refreshVerdicts,
  updateVerdict,
  removeFromPortfolio,
  updatePortfolioEntry,
  type PortfolioListResponse,
  type RescoreResponse,
  type UpdateVerdictInput,
} from '@/api/portfolio';
import { toast } from 'sonner';
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
    onSuccess: (data: RescoreResponse) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
      toast.success(`Rescored ${data.results.length} domains in ${data.totalDurationMs}ms`);
    },
    onError: () => {
      toast.error('Failed to rescore portfolio');
    },
  });
}

export function useRefreshVerdicts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshVerdicts,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
      toast.success('Verdicts refreshed');
    },
    onError: () => {
      toast.error('Failed to refresh verdicts');
    },
  });
}

export function useUpdateVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ domain, input }: { domain: string; input: UpdateVerdictInput }) =>
      updateVerdict(domain, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
      toast.success(`${variables.domain} → ${variables.input.verdict}`);
    },
    onError: (_err, variables) => {
      toast.error(`Failed to update verdict for ${variables.domain}`);
    },
  });
}

export function useRemoveFromPortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => removeFromPortfolio(domain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
      toast.success('Domain removed from portfolio');
    },
    onError: () => {
      toast.error('Failed to remove domain');
    },
  });
}

export function useUpdatePortfolioEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      domain,
      input,
    }: {
      domain: string;
      input: { notes?: string; acquisitionCost?: number; renewalCost?: number };
    }) => updatePortfolioEntry(domain, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
      toast.success(`${variables.domain} updated`);
    },
    onError: (_err, variables) => {
      toast.error(`Failed to update ${variables.domain}`);
    },
  });
}

export type { PortfolioEntry, PortfolioListResponse, RescoreResponse };
