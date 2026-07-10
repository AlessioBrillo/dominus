export interface StageMetrics {
  stageName: string;
  totalDurationMs: number;
  totalPassed: number;
  totalFiltered: number;
  runCount: number;
  lastRunAt: string | null;
  errorCount: number;
  totalRetries?: number;
}

export interface ProviderErrorMetric {
  providerName: string;
  method: string;
  errorCode: string;
  lastErrorAt: string;
}

export interface ProviderMetrics {
  providerName: string;
  totalCalls: number;
  totalErrors: number;
  lastCallDurationMs: number | null;
  lastErrorAt: string | null;
  currentErrors: ProviderErrorMetric[];
}

export interface PipelineRunSummary {
  totalRuns: number;
  totalCandidatesEvaluated: number;
  totalRecommended: number;
  stageMetrics: Record<string, StageMetrics>;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  providerMetrics: Record<string, ProviderMetrics>;
}

export interface SystemMetrics {
  uptimeSeconds: number;
  memoryUsageMb: number;
  pid: number;
  version: string;
  timestamp: string;
}

export interface MetricsSnapshot {
  pipeline: PipelineRunSummary;
  system: SystemMetrics;
}
