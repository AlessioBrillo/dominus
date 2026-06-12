import { useState, useEffect } from 'react';
import { fetchCandidates, runPipeline, fetchRuns, deleteCandidate } from '../api/candidates.js';
import { scoreDomain } from '../api/score.js';
import type { Candidate, PipelineRun } from '../types/domain.js';
import { CandidateCard } from '../components/CandidateCard.js';

export function CandidatesPage() {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRuns()
      .then((data) => {
        setRuns(data);
        if (data.length > 0 && !selectedRunId) {
          setSelectedRunId(data[0]!.runId);
        }
      })
      .catch(() => setError('Failed to load pipeline runs'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    fetchCandidates(selectedRunId)
      .then((data) => setCandidates(data))
      .catch(() => setError('Failed to load candidates'))
      .finally(() => setLoading(false));
  }, [selectedRunId]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await runPipeline({
        keywords: [],
        brandableNames: [],
        closeoutDomains: [],
      });
      const newRun: PipelineRun = {
        runId: result.runId,
        startedAt: new Date().toISOString(),
        stageSummary: result.stageSummary,
        totalDurationMs: result.totalDurationMs,
        resultsSummary: {},
      };
      setRuns((prev) => [newRun, ...prev]);
      setSelectedRunId(result.runId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Pipeline run failed');
    } finally {
      setRunning(false);
    }
  };

  const handleScore = async (domain: string) => {
    try {
      const result = await scoreDomain(domain);
      setCandidates((prev) =>
        prev.map((c) =>
          c.domain === domain
            ? {
                ...c,
                scoreResult: result.score,
                status: result.score.recommended ? 'recommended' : 'scored',
              }
            : c,
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Score failed';
      setError(`Failed to score ${domain}: ${message}`);
    }
  };

  const handleDelete = async (domain: string) => {
    try {
      await deleteCandidate(domain);
      setCandidates((prev) => prev.filter((c) => c.domain !== domain));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const recommended = candidates.filter((c) => c.status === 'recommended');
  const scored = candidates.filter((c) => c.status === 'scored' || c.status === 'unscored');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Candidates</h2>
          <p className="text-sm text-gray-500 mt-1">
            Buy / Pass decision board — {candidates.length} candidates
          </p>
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

      {error && (
        <div className="bg-red-950/50 border border-red-900 text-red-400 px-4 py-3 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}

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
              {new Date(run.startedAt).toLocaleDateString()} —
              {run.totalDurationMs ? ` ${(run.totalDurationMs / 1000).toFixed(1)}s` : ' ...'}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 animate-pulse text-center py-12">Loading candidates...</div>
      ) : candidates.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-600 text-lg mb-2">No candidates found</div>
          <p className="text-gray-700 text-sm">
            {selectedRunId
              ? 'This run has no candidates.'
              : 'Run a pipeline to generate candidates.'}
          </p>
        </div>
      ) : (
        <>
          {recommended.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Recommended ({recommended.length})
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {recommended.map((c) => (
                  <CandidateCard
                    key={c.id ?? c.domain}
                    candidate={c}
                    onScore={handleScore}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          )}
          {scored.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Scored / Pass ({scored.length})
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {scored.map((c) => (
                  <CandidateCard
                    key={c.id ?? c.domain}
                    candidate={c}
                    onScore={handleScore}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
