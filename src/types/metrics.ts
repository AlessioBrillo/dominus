// SPDX-License-Identifier: AGPL-3.0-only
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

export interface DnsConsensusMetrics {
  /** Available verdicts confirmed by the secondary across all runs. */
  verifiedTotal: number;
  /** Definitive disagreements (secondary Registered) across all runs. */
  disagreedTotal: number;
  /** Unanswerable domains (errors/timeouts) across all runs. */
  unverifiableTotal: number;
  /** Domains rescued by the tertiary leg (ADR-0045) across all runs. */
  tertiaryRescuedTotal: number;
  /** Number of runs flagged degraded over consensus (ADR-0039). */
  degradedRunsTotal: number;
  /** Whether the most recent consensus-checked run was degraded. */
  lastRunDegraded: boolean;
  /** Whether consensus ran at least once since process start. */
  observed: boolean;
}

/** Verdict labels reported by the trademark gate. */
export type TrademarkGateVerdict = 'clear' | 'blocked' | 'unverified';

export interface TrademarkGateMetrics {
  /** Checks resolved to Clear since process start. */
  clearTotal: number;
  /** Checks resolved to Blocked (trademark match) since process start. */
  blockedTotal: number;
  /** Checks resolved to Unverified (sources down) since process start. */
  unverifiedTotal: number;
  /** Clear verdicts that relied on a single responding source. */
  partialTotal: number;
  /** Checks where the USPTO source failed. */
  usptoFailuresTotal: number;
  /** Checks where the EUIPO source failed. */
  euipoFailuresTotal: number;
  /** Whether the gate ran at least once since process start. */
  observed: boolean;
}

export interface PipelineRunSummary {
  totalRuns: number;
  totalCandidatesEvaluated: number;
  totalRecommended: number;
  stageMetrics: Record<string, StageMetrics>;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  providerMetrics: Record<string, ProviderMetrics>;
  dnsConsensus?: DnsConsensusMetrics;
  trademarkGate?: TrademarkGateMetrics;
}

export interface SystemMetrics {
  uptimeSeconds: number;
  memoryUsageMb: number;
  pid: number;
  version: string;
  timestamp: string;
}

/** Backup + point-in-time recovery health (ADR-0054). Values are
 *  process-lifetime snapshots recorded by BackupService/PitrHealthService. */
export interface BackupMetrics {
  /** Epoch ms of the last successful database backup, or null. */
  lastSuccessAtMs: number | null;
  /** WAL archiving lag in bytes at the last pitr-health check. */
  pitrWalLagBytes: number | null;
  /** Age in hours of the newest base backup at the last check. */
  pitrBaseBackupAgeHours: number | null;
  /** True when PostgreSQL archived at least one WAL segment. */
  pitrArchivingActive: boolean | null;
  /** Epoch ms of the last pitr-health check, or null. */
  pitrCheckedAtMs: number | null;
}

export interface MetricsSnapshot {
  pipeline: PipelineRunSummary;
  system: SystemMetrics;
  backup: BackupMetrics;
}
