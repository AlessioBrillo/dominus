import { useState } from 'react';
import { Play } from 'lucide-react';
import { useCandidatesList, useRunsList, useRunPipeline } from '@/hooks/useCandidates';
import { CandidateCard } from '@/components/CandidateCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function CandidatesPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const { data: candidates = [], isLoading, error } = useCandidatesList(selectedRunId);
  const { data: runs = [] } = useRunsList();
  const runPipeline = useRunPipeline();

  const recommended = candidates.filter((c) => c.status === 'recommended');
  const scored = candidates.filter((c) => c.status !== 'recommended');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-text-primary">Candidates</h2>
        <Button onClick={() => runPipeline.mutate()} disabled={runPipeline.isPending}>
          <Play className="h-4 w-4 mr-2" />
          {runPipeline.isPending ? 'Running...' : 'Run Pipeline'}
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="flex flex-col items-center py-8">
            <p className="text-danger text-sm">
              {error instanceof Error ? error.message : 'Failed to load candidates'}
            </p>
          </CardContent>
        </Card>
      )}

      {runs.length > 0 && (
        <Tabs
          value={selectedRunId ?? 'all'}
          onValueChange={(v) => setSelectedRunId(v === 'all' ? undefined : v)}
        >
          <TabsList>
            <TabsTrigger value="all">All Runs</TabsTrigger>
            {runs.slice(0, 5).map((run) => (
              <TabsTrigger key={run.runId} value={run.runId}>
                {run.runId.slice(0, 8)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 space-y-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-16" />
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : candidates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <p className="text-text-muted text-sm mb-1">No candidates found</p>
            <p className="text-text-muted text-xs">Run a pipeline to generate candidates</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {recommended.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-success mb-3 uppercase tracking-wider flex items-center gap-2">
                Recommended
                <Badge variant="success">{recommended.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {recommended.map((c) => (
                  <CandidateCard key={c.domain} candidate={c} />
                ))}
              </div>
            </div>
          )}
          {scored.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-warning mb-3 uppercase tracking-wider flex items-center gap-2">
                Scored
                <Badge variant="warning">{scored.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {scored.map((c) => (
                  <CandidateCard key={c.domain} candidate={c} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
