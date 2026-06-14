import { useRunProgress, type RunProgressState } from '../hooks/useRunProgress.js';

interface RunProgressProps {
  runId: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  candidate_generation: 'Candidate Generation',
  dns_prefilter: 'DNS Pre-filter',
  rdap_confirmation: 'RDAP Confirmation',
  whois: 'WHOIS Lookup',
  scoring: 'Scoring',
  trademark_gate: 'Trademark Gate',
};

export function RunProgress({ runId }: RunProgressProps) {
  const progress = useRunProgress(runId);

  if (!runId || progress.status === 'idle') return null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Pipeline Progress
        </h3>
        <PipelineStatusBadge status={progress.status} />
      </div>

      {progress.status === 'connecting' && (
        <div className="text-sm text-gray-500 animate-pulse">Connecting...</div>
      )}

      {progress.stages.length > 0 && (
        <div className="space-y-2">
          {progress.stages.map((stage) => (
            <StageRow key={stage.name} stage={stage} />
          ))}
        </div>
      )}

      {progress.status === 'complete' && (
        <div className="text-sm text-emerald-400 font-medium pt-1">
          Complete — {progress.totalPassed ?? 0} passed, {progress.totalFiltered ?? 0} filtered in{' '}
          {((progress.totalDurationMs ?? 0) / 1000).toFixed(1)}s
        </div>
      )}

      {progress.status === 'error' && progress.error && (
        <div className="text-sm text-red-400">{progress.error}</div>
      )}
    </div>
  );
}

function PipelineStatusBadge({ status }: { status: RunProgressState['status'] }) {
  const colors: Record<string, string> = {
    connecting: 'bg-blue-900/50 text-blue-400',
    running: 'bg-cyan-900/50 text-cyan-400',
    complete: 'bg-emerald-900/50 text-emerald-400',
    error: 'bg-red-900/50 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? ''}`}>
      {status}
    </span>
  );
}

function StageRow({
  stage,
}: {
  stage: {
    name: string;
    passed: number;
    filtered: number;
    durationMs: number;
    error: boolean;
    complete: boolean;
  };
}) {
  const label = STAGE_LABELS[stage.name] ?? stage.name;
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-950 text-sm">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            stage.error ? 'bg-red-500' : stage.complete ? 'bg-emerald-500' : 'bg-amber-500'
          }`}
        />
        <span className="text-gray-200">{label}</span>
      </div>
      <span className="text-gray-500 font-mono text-xs">
        +{stage.passed} / -{stage.filtered} · {(stage.durationMs / 1000).toFixed(1)}s
      </span>
    </div>
  );
}
