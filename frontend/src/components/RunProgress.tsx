import { useRunProgress } from '@/hooks/useRunProgress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface RunProgressProps {
  runId: string | null;
}

const stageOrder = [
  'CandidateGenerationStage',
  'DnsPreFilterStage',
  'WhoisStage',
  'RdapConfirmationStage',
  'ScoringStage',
  'TrademarkGateStage',
];

export function RunProgress({ runId }: RunProgressProps) {
  const progress = useRunProgress(runId);

  if (!runId) return null;

  if (progress.status === 'idle') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pipeline Run</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-muted">Starting pipeline...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Pipeline Run</CardTitle>
          <Badge variant="info" className="font-mono text-[10px]">
            {runId.slice(0, 8)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {stageOrder.map((stageName) => {
          const stage = progress.stages?.find((s) => s.name === stageName);
          const hasRun = stage != null;

          return (
            <div
              key={stageName}
              className={cn(
                'flex items-center justify-between px-3 py-2 rounded-lg text-sm',
                hasRun && stage.complete && 'opacity-70',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-block w-2 h-2 rounded-full',
                    stage?.error && 'bg-danger',
                    stage?.complete && !stage.error && 'bg-success',
                    !hasRun && progress.status === 'running' && 'bg-text-muted',
                    hasRun && !stage.complete && !stage.error && 'bg-brand-400 animate-pulse',
                  )}
                />
                <span className="text-text-primary">{stageName}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-text-muted">
                {stage && (
                  <>
                    <span>{stage.passed ?? 0} passed</span>
                    <span>{stage.filtered ?? 0} filtered</span>
                  </>
                )}
                {stage?.complete && stage.durationMs != null && (
                  <span className="font-mono">{(stage.durationMs / 1000).toFixed(1)}s</span>
                )}
                {stage?.error && <Badge variant="danger">Error</Badge>}
              </div>
            </div>
          );
        })}

        {progress.status === 'complete' && progress.stages && (
          <div className="pt-2 text-sm text-success font-medium">
            Pipeline completed in{' '}
            {(progress.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) / 1000).toFixed(1)}s
          </div>
        )}

        {progress.status === 'error' && (
          <div className="pt-2 text-sm text-danger font-medium">Pipeline failed</div>
        )}
      </CardContent>
    </Card>
  );
}
