import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  preflightPurchase,
  executePurchase,
  type PurchaseCheckResponse,
  type PurchaseExecuteResponse,
} from '@/api/purchase';
import { toast } from 'sonner';
import { queryKeys } from './query-keys';

export function usePreflight(domain: string | null) {
  return useQuery({
    queryKey: ['purchase', 'preflight', domain],
    queryFn: () => preflightPurchase(domain!),
    enabled: domain !== null && domain.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useExecutePurchase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      domain,
      years,
      operatorApproved,
    }: {
      domain: string;
      years?: number;
      operatorApproved?: boolean;
    }) => executePurchase(domain, years, operatorApproved),
    onSuccess: (result: PurchaseExecuteResponse) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.all });
        queryClient.invalidateQueries({ queryKey: queryKeys.candidates.all });
        toast.success(`${result.purchase?.domain} purchased successfully`);
      } else {
        toast.error(result.message ?? result.error ?? 'Purchase failed');
      }
    },
    onError: () => {
      toast.error('Purchase request failed');
    },
  });
}

export type { PurchaseCheckResponse, PurchaseExecuteResponse };
