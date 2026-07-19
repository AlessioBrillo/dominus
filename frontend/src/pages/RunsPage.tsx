import { useState } from 'react';
import { RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useRunsList, useDeleteRun, usePruneRuns } from '@/hooks/useRuns';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { MetricCard } from '@/components/MetricCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface StageInfo {
  passed: number;
  filtered: number;
  durationMs: number;
}

function runStatus(run: { finishedAt?: string }): string {
  return run.finishedAt ? 'completed' : 'running';
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function RunsPage() {
  const { data: runs = [], isLoading, error, refetch } = useRunsList();
  const deleteRun = useDeleteRun();
  const pruneRuns = usePruneRuns();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const activeRuns = runs.filter((r) => !r.finishedAt).length;
  const totalRuns = runs.length;
  const avgDuration =
    runs.length > 0
      ? Math.round(runs.reduce((s, r) => s + (r.totalDurationMs ?? 0), 0) / runs.length)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        subtitle="Pipeline execution history"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => pruneRuns.mutate(true)}
              disabled={pruneRuns.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Prune Old
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Total Runs" value={String(totalRuns)} accent="text-brand-400" />
        <MetricCard
          label="Active"
          value={String(activeRuns)}
          accent={activeRuns > 0 ? 'text-success' : 'text-text-muted'}
        />
        <MetricCard label="Avg Duration" value={avgDuration ? formatMs(avgDuration) : '—'} />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-danger text-sm">
              {error instanceof Error ? error.message : 'Failed to load runs'}
            </p>
          </CardContent>
        </Card>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No pipeline runs yet"
          description="Run a pipeline from the Candidates page to see execution history here."
        />
      ) : (
        <div className="space-y-3">
          {runs.map((run) => {
            const isSelected = selectedRunId === run.runId;
            const status = runStatus(run);
            const stages: Record<string, StageInfo> = run.stageSummary ?? {};
            const stageNames = Object.keys(stages);

            return (
              <Card
                key={run.runId}
                className={`cursor-pointer transition-colors ${isSelected ? 'ring-2 ring-brand-500' : 'hover:bg-bg-hover'}`}
                onClick={() => setSelectedRunId(isSelected ? null : run.runId)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-text-primary">
                        {run.runId.slice(0, 12)}…
                      </span>
                      <StatusBadge status={status} />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      {run.totalDurationMs != null && <span>{formatMs(run.totalDurationMs)}</span>}
                      <span>{new Date(run.startedAt).toLocaleString()}</span>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-text-muted hover:text-danger"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove run {run.runId.slice(0, 12)} and its candidates. This action
                              cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteRun.mutate(run.runId)}
                              className="bg-danger hover:bg-danger/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                  {stageNames.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {stageNames.map((name) => {
                        const s = stages[name];
                        return s ? (
                          <span
                            key={name}
                            className="text-xs px-2 py-0.5 rounded-full bg-bg-muted text-text-muted"
                            title={`${s.passed} passed, ${s.filtered} filtered in ${formatMs(s.durationMs)}`}
                          >
                            {name}: {s.passed}/{s.passed + s.filtered}
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  {isSelected && (
                    <div className="mt-4 pt-3 border-t border-border">
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-text-muted text-xs uppercase block mb-1">
                            Run ID
                          </span>
                          <span className="font-mono text-text-primary">{run.runId}</span>
                        </div>
                        <div>
                          <span className="text-text-muted text-xs uppercase block mb-1">
                            Started
                          </span>
                          <span className="text-text-secondary">
                            {new Date(run.startedAt).toLocaleString()}
                          </span>
                        </div>
                        {run.finishedAt && (
                          <div>
                            <span className="text-text-muted text-xs uppercase block mb-1">
                              Finished
                            </span>
                            <span className="text-text-secondary">
                              {new Date(run.finishedAt).toLocaleString()}
                            </span>
                          </div>
                        )}
                        {run.totalDurationMs != null && (
                          <div>
                            <span className="text-text-muted text-xs uppercase block mb-1">
                              Duration
                            </span>
                            <span className="text-text-secondary">
                              {formatMs(run.totalDurationMs)}
                            </span>
                          </div>
                        )}
                      </div>
                      {stageNames.length > 0 && (
                        <div className="mt-3">
                          <span className="text-text-muted text-xs uppercase block mb-2">
                            Stage Details
                          </span>
                          <div className="space-y-1.5">
                            {stageNames.map((name) => {
                              const s = stages[name];
                              if (!s) return null;
                              const passRate =
                                s.passed + s.filtered > 0
                                  ? ((s.passed / (s.passed + s.filtered)) * 100).toFixed(1)
                                  : '0';
                              return (
                                <div
                                  key={name}
                                  className="flex items-center justify-between text-xs bg-bg-muted px-3 py-1.5 rounded"
                                >
                                  <span className="text-text-primary font-medium capitalize">
                                    {name}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <span className="text-text-muted">
                                      {s.passed} passed / {s.filtered} filtered
                                    </span>
                                    <span className="text-text-muted">
                                      {formatMs(s.durationMs)}
                                    </span>
                                    <span
                                      className={
                                        Number(passRate) >= 50 ? 'text-success' : 'text-warning'
                                      }
                                    >
                                      {passRate}%
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
