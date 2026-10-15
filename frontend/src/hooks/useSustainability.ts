// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { getSustainability, type CarryCostResult } from '@/api/sustainability';
import { queryKeys } from './query-keys';

/** Carry-cost verdicts: what each held domain earns per year against its renewal. */
export function useSustainability() {
  return useQuery({
    queryKey: queryKeys.sustainability.all,
    queryFn: getSustainability,
    staleTime: 30_000,
    select: (data: { verdicts: CarryCostResult[] }) => data.verdicts,
  });
}
