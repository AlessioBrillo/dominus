import { useState } from 'react';
import { RefreshCw, TrendingUp, AlertTriangle } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  useBacktestReport,
  useRebuildSnapshot,
  useSuggestWeights,
  useAutoTune,
} from '@/hooks/useBacktest';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

export function BacktestPage() {
  const { data: report, isLoading, error, refetch } = useBacktestReport();
  const rebuild = useRebuildSnapshot();
  const suggest = useSuggestWeights();
  const autoTune = useAutoTune();

  const [showWeights, setShowWeights] = useState(false);
  const [suggestion, setSuggestion] = useState<Record<string, number> | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Backtest" subtitle="Prediction accuracy analysis" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-3 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-7 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="p-8">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Backtest" />
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-danger text-sm mb-4">
              {error instanceof Error ? error.message : 'Failed to load backtest data'}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Backtest"
          subtitle="Prediction accuracy analysis"
          actions={
            <Button size="sm" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              {rebuild.isPending ? 'Rebuilding...' : 'Rebuild Signals'}
            </Button>
          }
        />
        <EmptyState
          icon={<TrendingUp className="h-8 w-8" />}
          title="No backtest data"
          description="Rebuild backtest signals from historical outcomes to see prediction accuracy."
          action={
            <Button size="sm" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
              {rebuild.isPending ? 'Rebuilding...' : 'Rebuild Signals'}
            </Button>
          }
        />
      </div>
    );
  }

  const accuracy = report.accuracy;
  const calibrationData = accuracy.calibration
    ? Object.entries(accuracy.calibration).map(([bucket, stats]) => ({
        name: bucket,
        predicted: stats.meanPredicted,
        actual: stats.meanRealised,
      }))
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backtest"
        subtitle={`Sample: ${report.sampleSize} outcomes`}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const result = await suggest.mutateAsync(false);
                  setSuggestion(result.suggested);
                  setShowWeights(true);
                } catch {
                  /* handled */
                }
              }}
              disabled={suggest.isPending}
            >
              <TrendingUp className="h-3.5 w-3.5 mr-1" />
              Suggest Weights
            </Button>
            <Button size="sm" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1 ${rebuild.isPending ? 'animate-spin' : ''}`}
              />
              {rebuild.isPending ? 'Rebuilding...' : 'Rebuild'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Sample Size</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-text-primary">
              {report.sampleSize}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>MAPE</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold font-mono"
              style={{ color: accuracy.overall.mape < 0.5 ? '#10b981' : '#ef4444' }}
            >
              {(accuracy.overall.mape * 100).toFixed(1)}%
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>RMSE</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-text-primary">
              €{accuracy.overall.rmse.toFixed(0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>F1 Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold font-mono"
              style={{ color: accuracy.confusionMatrix.f1 > 0.5 ? '#10b981' : '#f59e0b' }}
            >
              {(accuracy.confusionMatrix.f1 * 100).toFixed(1)}%
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Calibration</CardTitle>
          </CardHeader>
          <CardContent>
            {calibrationData.length > 0 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={calibrationData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="predicted"
                      fill="var(--brand-500)"
                      name="Predicted"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar dataKey="actual" fill="#10b981" name="Actual" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-text-muted py-8 text-center">
                No calibration data available
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Confusion Matrix</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-bg-muted rounded-lg p-3 text-center">
                <span className="text-xs text-text-muted block">TP</span>
                <span className="text-lg font-bold font-mono text-success">
                  {accuracy.confusionMatrix.truePositives}
                </span>
              </div>
              <div className="bg-bg-muted rounded-lg p-3 text-center">
                <span className="text-xs text-text-muted block">FP</span>
                <span className="text-lg font-bold font-mono text-danger">
                  {accuracy.confusionMatrix.falsePositives}
                </span>
              </div>
              <div className="bg-bg-muted rounded-lg p-3 text-center">
                <span className="text-xs text-text-muted block">TN</span>
                <span className="text-lg font-bold font-mono text-text-primary">
                  {accuracy.confusionMatrix.trueNegatives}
                </span>
              </div>
              <div className="bg-bg-muted rounded-lg p-3 text-center">
                <span className="text-xs text-text-muted block">FN</span>
                <span className="text-lg font-bold font-mono text-warning">
                  {accuracy.confusionMatrix.falseNegatives}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3">
              <div className="text-center">
                <span className="text-xs text-text-muted block">Precision</span>
                <span className="font-mono text-sm">
                  {(accuracy.confusionMatrix.precision * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-center">
                <span className="text-xs text-text-muted block">Recall</span>
                <span className="font-mono text-sm">
                  {(accuracy.confusionMatrix.recall * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-center">
                <span className="text-xs text-text-muted block">F1</span>
                <span className="font-mono text-sm">
                  {(accuracy.confusionMatrix.f1 * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {showWeights && suggestion && (
        <Card>
          <CardHeader>
            <CardTitle>Weight Suggestion</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(suggestion).map(([signal, weight]) => (
                <div key={signal} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary capitalize">{signal}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-text-muted">{(weight * 100).toFixed(1)}%</span>
                  </div>
                </div>
              ))}
              <div className="pt-3 border-t border-border">
                <Button size="sm" onClick={() => autoTune.mutate()} disabled={autoTune.isPending}>
                  {autoTune.isPending ? 'Applying...' : 'Apply Suggested Weights'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {accuracy.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Warnings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {accuracy.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-warning">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
