import { useState } from 'react';
import { Search, AlertTriangle } from 'lucide-react';
import { scoreDomain } from '@/api/score';
import { ScoreGauge } from '@/components/ScoreGauge';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import type { ScoreResponse } from '@/api/score';

export function ScorePage() {
  const [domainInput, setDomainInput] = useState('');
  const [scoring, setScoring] = useState(false);
  const [result, setResult] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScore = async () => {
    const domain = domainInput.trim();
    if (!domain) return;
    setScoring(true);
    setError(null);
    setResult(null);
    try {
      const res = await scoreDomain(domain);
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to score domain');
    } finally {
      setScoring(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Score a Domain" subtitle="Ad-hoc domain valuation with trademark check" />

      <Card>
        <CardHeader>
          <CardTitle>Domain Lookup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              placeholder="example.com"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleScore()}
              className="flex-1"
            />
            <Button onClick={handleScore} disabled={scoring || !domainInput.trim()}>
              <Search className="h-4 w-4 mr-1" />
              {scoring ? 'Scoring...' : 'Score'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {scoring && (
        <Card>
          <CardContent className="py-8">
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="h-32 w-32 rounded-full" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-center gap-3 text-danger">
              <AlertTriangle className="h-5 w-5" />
              <p className="text-sm">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {result && !scoring && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-1">
              <CardContent className="py-6 space-y-4">
                <ScoreGauge label="Confidence" value={result.score.confidence} max={1} />
                <ScoreGauge label="Weighted Score" value={result.score.weightedScore} max={1} />
              </CardContent>
            </Card>
            <div className="lg:col-span-2 grid grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Expected Value</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-accent">
                    €{result.score.expectedValue.toFixed(0)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Recommendation</CardTitle>
                </CardHeader>
                <CardContent>
                  <Badge
                    variant={result.score.recommended ? 'success' : 'outline'}
                    className="text-sm px-3 py-1"
                  >
                    {result.score.recommended ? 'BUY' : 'PASS'}
                  </Badge>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Suggested Buy Max</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-brand-400">
                    €{result.score.suggestedBuyMax.toFixed(0)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Suggested List Price</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-success">
                    €{result.score.suggestedListPrice.toFixed(0)}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Signal Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {Object.entries(result.score.breakdown).map(([key, val]) => (
                  <div key={key} className="bg-bg-muted rounded-lg p-3">
                    <span className="text-xs text-text-muted uppercase block mb-1">{key}</span>
                    <span className="text-lg font-bold font-mono text-text-primary">
                      {(val.score * 100).toFixed(0)}
                    </span>
                    <span className="text-xs text-text-muted ml-1">
                      (w: {(val.weight * 100).toFixed(0)}%)
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {result.trademark && (
            <Card>
              <CardHeader>
                <CardTitle>Trademark Check</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      result.trademark.verdict === 'clear'
                        ? 'success'
                        : result.trademark.verdict === 'blocked'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {result.trademark.verdict}
                  </Badge>
                  <span className="text-sm text-text-secondary">
                    Verified sources: {result.trademark.verifiedSources.join(', ') || 'none'}
                  </span>
                  {result.trademark.partial && (
                    <span className="text-xs text-warning">(partial — one source unavailable)</span>
                  )}
                </div>
                {result.trademark.matchedMark && (
                  <p className="text-sm text-danger mt-2">
                    Match found: {result.trademark.matchedMark}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
