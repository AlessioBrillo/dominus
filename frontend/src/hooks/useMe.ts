// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { fetchMe, type Me } from '@/api/me';
import { queryKeys } from './query-keys';

/** @param enabled false while signed out, so the call never fires unauthenticated. */
export function useMe(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.me.current(),
    queryFn: ({ signal }) => fetchMe(signal),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const role = query.data?.role ?? null;
  return {
    ...query,
    me: query.data,
    /** Cross-tenant platform operator (shows the Admin panel). */
    isOperator: role === 'operator',
    /** Can manage the team, keys and billing of their own tenant. */
    isAdmin: role === 'admin' || role === 'operator',
  };
}

export type { Me };
