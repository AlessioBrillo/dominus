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

export interface RdapConsensusMetrics {
  /** Available verdicts confirmed by the second RDAP leg across all runs. */
  verifiedTotal: number;
  /** Definitive disagreements (second leg Registered) across all runs. */
  disagreedTotal: number;
  /** Unanswerable domains (errors/timeouts) across all runs. */
  unverifiableTotal: number;
  /** Domains rescued by the opt-in WHOIS rescue leg (ADR-0051). */
  whoisRescuedTotal: number;
  /** Verdicts skipped on per-TLD origin overlap (ADR-0058). */
  originOverlapTotal: number;
  /** Verdicts downgraded on origin-guard resolver failure (ADR-0060). */
  originGuardUnavailableTotal: number;
  /** Number of runs flagged degraded over RDAP consensus. */
  degradedRunsTotal: number;
  /** Whether the most recent consensus-checked run was degraded. */
  lastRunDegraded: boolean;
  /** Whether RDAP consensus ran at least once since process start. */
  observed: boolean;
}

/** IANA RDAP bootstrap health, recorded on every refresh outcome (ADR-0058). */
export interface RdapBootstrapMetrics {
  /** Whether the latest bootstrap refresh succeeded. Null before the first outcome. */
  ok: boolean | null;
  /** Consecutive failed refresh attempts since the last success. */
  consecutiveFailures: number;
  /** Epoch ms of the last successful refresh, or null. */
  lastSuccessAtMs: number | null;
  /** Epoch ms of the next retry after a failure, or null. */
  nextRetryAtMs: number | null;
  /** Whether any bootstrap outcome was recorded since process start. */
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
  rdapConsensus?: RdapConsensusMetrics;
  trademarkGate?: TrademarkGateMetrics;
  dnsBreakers?: DnsBreakerMetrics;
}

/** Current DNS circuit-breaker state counts across all tracked endpoints
 *  (ADR-0059). Snapshot-based: reflects the latest interaction, not a
 *  monotonically increasing total. */
export interface DnsBreakerMetrics {
  /** Endpoints whose circuit is open (queries skipped until cooldown). */
  open: number;
  /** Endpoints whose circuit is closed (normal operation). */
  closed: number;
  /** Endpoints currently half-open (single probe allowed). */
  halfOpen: number;
  /** Total endpoints tracked by the registry. */
  total: number;
  /** Whether any breaker interaction was recorded since process start. */
  observed: boolean;
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

/** Anonymous trademark-gate budget outcomes (ADR-0056). */
export interface AnonTrademarkBudgetMetrics {
  /** Gate checks executed for anonymous valuations since process start. */
  hitsTotal: number;
  /** Anonymous valuations failed open to 'unverified' because the budget
   *  could not grant a slot in time (fail-open, ADR-0056). */
  blockedTotal: number;
  /** Whether any anonymous budget outcome was recorded since process start. */
  observed: boolean;
}

export interface MetricsSnapshot {
  pipeline: PipelineRunSummary;
  system: SystemMetrics;
  backup: BackupMetrics;
  /** Optional so callers constructing snapshots remain valid even when the
   *  anonymous trademark budget has never fired. */
  anonTrademark?: AnonTrademarkBudgetMetrics;
  /** IANA RDAP bootstrap health (ADR-0058). Always present; `observed`
   *  distinguishes "never recorded" from a healthy/failed refresh. */
  rdapBootstrap?: RdapBootstrapMetrics;
}
