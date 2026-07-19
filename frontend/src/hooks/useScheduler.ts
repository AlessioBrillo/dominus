import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { fetchSchedulerStatus, runSchedulerJob } from '@/api/scheduler';
import type { SchedulerJob } from '@/api/scheduler';
import { toast } from 'sonner';

export function useSchedulerStatus() {
  return useQuery({
    queryKey: queryKeys.scheduler.list(),
    queryFn: fetchSchedulerStatus,
    staleTime: 30_000,
  });
}

export function useRunSchedulerJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobName: string) => runSchedulerJob(jobName),
    onSuccess: (_data, jobName) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.all });
      toast.success(`Job "${jobName}" started`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export type { SchedulerJob };
