import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import { runPipeline } from '../api/candidates.js';
import { scoreDomain } from '../api/score.js';
import type { Candidate, PipelineRun } from '../types/domain.js';
import { CandidateCard } from '../components/CandidateCard.js';

export function CandidatesPage() {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api
      .get<{ runs: PipelineRun[] }>('/api/runs')
      .then((data) => {
        setRuns(data.runs);
        if (data.runs.length > 0 && !selectedRunId) {
          setSelectedRunId(data.runs[0]!.runId);
        }
      })
      .finally(() => setLoading(false));
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) return;
    api
      .get<{ candidates: Candidate[] }>(
        `/api/candidates?runId=${encodeURIComponent(selectedRunId)}`,
      )
      .then((data) => setCandidates(data.candidates))
      .catch(() => setCandidates([]));
  }, [selectedRunId]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const result = await runPipeline({ keywords: [], brandableNames: [], closeoutDomains: [] });
      setRuns((prev) => [
        {
          runId: result.runId,
          startedAt: new Date().toISOString(),
          stageSummary: result.stageSummary,
          totalDurationMs: result.totalDurationMs,
          resultsSummary: {},
        },
        ...prev,
      ]);
      setSelectedRunId(result.runId);
    } finally {
      setRunning(false);
    }
  };

  const handleScore = async (domain: string) => {
    try {
      const result = await scoreDomain(domain);
      setCandidates((prev) =>
        prev.map((c) =>
          c.domain === domain ? { ...c, scoreResult: result.score, status: result.score.recommended ? 'recommended' : 'scored' } : c,
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Score failed';
      alert(`Failed to score ${domain}: ${message}`);
    }
  };

  const recommended = candidates.filter((c) => c.status === 'recommended');
  const scored = candidates.filter((c) => c.status === 'scored' || c.status === 'unscored');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Candidates</h2>
          <p className="text-sm text-gray-500 mt-1">Buy / Pass decision board</p>
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {running ? (
            <span className="animate-pulse">Running...</span>
          ) : (
            <>
              <span>▶</span> Run Pipeline
            </>
          )}
        </button>
      </div>

      {runs.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {runs.map((run) => (
            <button
              key={run.runId}
              onClick={() => setSelectedRunId(run.runId)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                selectedRunId === run.runId
                  ? 'bg-cyan-900/40 text-cyan-300 border border-cyan-800'
                  : 'bg-gray-900 text-gray-400 border border-gray-800 hover:border-gray-700'
              }`}
            >
              {new Date(run.startedAt).toLocaleDateString()} —{' '}
              {run.totalDurationMs ? `${(run.totalDurationMs / 1000).toFixed(1)}s` : '...'}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 animate-pulse text-center py-12">Loading candidates...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {recommended.map((c) => (
            <CandidateCard key={c.id ?? c.domain} candidate={c} onScore={handleScore} />
          ))}
          {scored.map((c) => (
            <CandidateCard key={c.id ?? c.domain} candidate={c} onScore={handleScore} />
          ))}
        </div>
      )}

      {!loading && candidates.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-600 text-lg mb-2">No candidates found</div>
          <p className="text-gray-700 text-sm">
            Run a pipeline to generate candidates, or select a previous run.
          </p>
        </div>
      )}
    </div>
  );
}
