// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchTeamSummary, inviteMember, updateMemberRole, removeMember } from '@/api/team';
import { queryKeys } from './query-keys';

export function useTeamSummary() {
  return useQuery({
    queryKey: queryKeys.team.summary(),
    queryFn: fetchTeamSummary,
    staleTime: 30_000,
  });
}

function useInvalidateTeam() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.team.summary() });
}

export function useInviteMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'member' }) =>
      inviteMember(input.userId, input.role),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to invite member'),
  });
}

export function useUpdateMemberRole() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'member' }) =>
      updateMemberRole(input.userId, input.role),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to update role'),
  });
}

export function useRemoveMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (userId: string) => removeMember(userId),
    onSuccess: invalidate,
    onError: () => toast.error('Failed to remove member'),
  });
}
