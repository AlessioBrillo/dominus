import { RefreshCw, Play } from 'lucide-react';
import { useSchedulerStatus, useRunSchedulerJob } from '@/hooks/useScheduler';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function SchedulerPage() {
  const { data: jobs = [], isLoading, error, refetch } = useSchedulerStatus();
  const runJob = useRunSchedulerJob();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scheduler"
        subtitle="Cron-based background job management"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-danger text-sm">
            {error instanceof Error ? error.message : 'Failed to load scheduler status'}
          </CardContent>
        </Card>
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No scheduled jobs"
          description="No jobs are configured. The scheduler runs in the scheduler container."
        />
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.name}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-text-primary capitalize">
                        {job.name.replace(/_/g, ' ')}
                      </span>
                      <StatusBadge status={job.enabled ? 'completed' : 'expired'} />
                    </div>
                    <div className="flex items-center gap-4 text-xs text-text-muted">
                      <span>
                        Cron: <code className="font-mono text-text-secondary">{job.cron}</code>
                      </span>
                      {job.lastRunAt && (
                        <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span>
                      )}
                      {job.nextRunAt && (
                        <span>Next: {new Date(job.nextRunAt).toLocaleString()}</span>
                      )}
                      {job.lastStatus && (
                        <span>
                          Status:{' '}
                          <StatusBadge
                            status={job.lastStatus === 'completed' ? 'completed' : 'failed'}
                          />
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runJob.mutate(job.name)}
                    disabled={runJob.isPending}
                  >
                    <Play className="h-3.5 w-3.5 mr-1" />
                    Run Now
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
