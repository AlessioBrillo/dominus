// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  MetricsSnapshot,
  StageMetrics,
  ProviderMetrics,
  ProviderErrorMetric,
  TrademarkGateVerdict,
  HistogramSample,
} from '../types/metrics.js';
import type { DnsBreakerStats } from '../providers/dns/dns-breaker.js';

/**
 * Default latency buckets (ms) for the SLO histograms (ADR-0064): span the
 * DNS lookup timeout default (1500 ms) and the RDAP timeout default
 * (10 s), leaving headroom for configured timeouts.
 */
export const DEFAULT_HISTOGRAM_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000,
];

/** Stable key for a histogram sample: name + sorted, escaped labels. */
function histogramKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const escaped = entries
    .map(
      ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
  return `${name}{${escaped}}`;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export class MetricsCollector {
  #stageMetrics: Map<string, StageMetrics> = new Map();
  #providerMetrics: Map<string, ProviderMetrics> = new Map();
  #totalRuns = 0;
  #totalCandidatesEvaluated = 0;
  #totalRecommended = 0;
  #lastRunAt: string | null = null;
  #lastRunDurationMs: number | null = null;
  #dnsConsensusVerified = 0;
  #dnsConsensusDisagreed = 0;
  #dnsConsensusUnverifiable = 0;
  #dnsConsensusTertiaryRescued = 0;
  #dnsConsensusDegradedRuns = 0;
  #dnsConsensusLastDegraded = false;
  #dnsConsensusObserved = false;
  #dnsBreakerOpen = 0;
  #dnsBreakerClosed = 0;
  #dnsBreakerHalfOpen = 0;
  #dnsBreakerTotal = 0;
  #dnsBreakersObserved = false;
  #rdapConsensusVerified = 0;
  #rdapConsensusDisagreed = 0;
  #rdapConsensusUnverifiable = 0;
  #rdapConsensusWhoisRescued = 0;
  #rdapConsensusOriginOverlap = 0;
  #rdapConsensusOriginGuardUnavailable = 0;
  #rdapConsensusDegradedRuns = 0;
  #rdapConsensusLastDegraded = false;
  #rdapConsensusObserved = false;
  #rdapBootstrapOk: boolean | null = null;
  #rdapBootstrapFailures = 0;
  #rdapBootstrapLastSuccessAtMs: number | null = null;
  #rdapBootstrapNextRetryAtMs: number | null = null;
  #rdapBootstrapObserved = false;
  #tmGateClear = 0;
  #tmGateBlocked = 0;
  #tmGateUnverified = 0;
  #tmGatePartial = 0;
  #tmGateUsptoFailures = 0;
  #tmGateEuipoFailures = 0;
  #tmGateObserved = false;
  #backupLastSuccessAtMs: number | null = null;
  #pitrWalLagBytes: number | null = null;
  #pitrBaseBackupAgeHours: number | null = null;
  #pitrArchivingActive: boolean | null = null;
  #pitrCheckedAtMs: number | null = null;
  #anonTrademarkHits = 0;
  #anonTrademarkBlocked = 0;
  #anonTrademarkObserved = false;
  #histograms: Map<string, HistogramSample> = new Map();

  /** Record one observation into a latency histogram (SLO observability,
   *  ADR-0064). Non-finite or negative samples are dropped; labels must be
   *  low-cardinality (transport/endpoint/verdict/role, server names). */
  recordHistogram(
    name: string,
    valueMs: number,
    labels: Record<string, string>,
    bucketsMs: number[] = DEFAULT_HISTOGRAM_BUCKETS_MS,
  ): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const key = histogramKey(name, labels);
    const existing =
      this.#histograms.get(key) ??
      ({
        name,
        labels: { ...labels },
        bucketCounts: new Array(bucketsMs.length).fill(0),
        bucketsMs: [...bucketsMs],
        count: 0,
        sum: 0,
      } as HistogramSample);
    existing.count++;
    existing.sum += valueMs;
    for (let i = 0; i < existing.bucketCounts.length; i++) {
      if (valueMs <= (existing.bucketsMs[i] ?? Infinity)) {
        existing.bucketCounts[i] = (existing.bucketCounts[i] ?? 0) + 1;
      }
    }
    this.#histograms.set(key, existing);
  }

  recordStage(
    stageName: string,
    passed: number,
    filtered: number,
    durationMs: number,
    error: boolean,
    retries?: number,
    _errorCodes?: string[],
  ): void {
    const existing = this.#stageMetrics.get(stageName) ?? {
      stageName,
      totalDurationMs: 0,
      totalPassed: 0,
      totalFiltered: 0,
      runCount: 0,
      lastRunAt: null,
      errorCount: 0,
      totalRetries: 0,
    };
    existing.totalDurationMs += durationMs;
    existing.totalPassed += passed;
    existing.totalFiltered += filtered;
    existing.runCount++;
    existing.lastRunAt = new Date().toISOString();
    if (error) existing.errorCount++;
    if (retries) existing.totalRetries = (existing.totalRetries ?? 0) + retries;
    this.#stageMetrics.set(stageName, existing);
  }

  recordPipelineRun(totalCandidates: number, recommended: number, durationMs: number): void {
    this.#totalRuns++;
    this.#totalCandidatesEvaluated += totalCandidates;
    this.#totalRecommended += recommended;
    this.#lastRunAt = new Date().toISOString();
    this.#lastRunDurationMs = durationMs;
  }

  recordDnsConsensus(stats: {
    verified: number;
    disagreed: number;
    unverifiable: number;
    degraded: boolean;
    tertiaryRescued?: number;
  }): void {
    this.#dnsConsensusVerified += stats.verified;
    this.#dnsConsensusDisagreed += stats.disagreed;
    this.#dnsConsensusUnverifiable += stats.unverifiable;
    this.#dnsConsensusTertiaryRescued += stats.tertiaryRescued ?? 0;
    this.#dnsConsensusObserved = true;
    this.#dnsConsensusLastDegraded = stats.degraded;
    if (stats.degraded) this.#dnsConsensusDegradedRuns++;
  }

  /** Record the current DNS circuit-breaker state counts (fed by the shared
   *  registry's onChange hook, wired in the composition root, ADR-0059).
   *  Snapshot-based, not cumulative: each interaction overwrites the counts. */
  recordDnsBreakers(stats: DnsBreakerStats): void {
    this.#dnsBreakerOpen = stats.open;
    this.#dnsBreakerClosed = stats.closed;
    this.#dnsBreakerHalfOpen = stats.halfOpen;
    this.#dnsBreakerTotal = stats.total;
    this.#dnsBreakersObserved = true;
  }

  /** Record per-run 2-of-2 RDAP consensus tallies (fed by the pipeline
   *  orchestrator from the stage's rdapConsensusStats, ADR-0058). */
  recordRdapConsensus(stats: {
    verified: number;
    disagreed: number;
    unverifiable: number;
    degraded: boolean;
    whoisRescued?: number;
    originOverlap?: number;
    originGuardUnavailable?: number;
  }): void {
    this.#rdapConsensusVerified += stats.verified;
    this.#rdapConsensusDisagreed += stats.disagreed;
    this.#rdapConsensusUnverifiable += stats.unverifiable;
    this.#rdapConsensusWhoisRescued += stats.whoisRescued ?? 0;
    this.#rdapConsensusOriginOverlap += stats.originOverlap ?? 0;
    this.#rdapConsensusOriginGuardUnavailable += stats.originGuardUnavailable ?? 0;
    this.#rdapConsensusObserved = true;
    this.#rdapConsensusLastDegraded = stats.degraded;
    if (stats.degraded) this.#rdapConsensusDegradedRuns++;
  }

  /** Record the latest IANA RDAP bootstrap refresh outcome (fed by the
   *  bootstrap's subscribeStatus listener, ADR-0058). */
  recordRdapBootstrap(status: {
    ok: boolean;
    consecutiveFailures: number;
    lastSuccessAtMs: number | null;
    nextRetryAtMs: number | null;
  }): void {
    this.#rdapBootstrapObserved = true;
    this.#rdapBootstrapOk = status.ok;
    this.#rdapBootstrapFailures = status.consecutiveFailures;
    this.#rdapBootstrapLastSuccessAtMs = status.lastSuccessAtMs;
    this.#rdapBootstrapNextRetryAtMs = status.nextRetryAtMs;
  }

  /** Record the outcome of a single trademark-gate check (fed by the gate's
   *  onResult telemetry callback, wired in the composition root). */
  recordTrademarkGate(stats: {
    verdict: TrademarkGateVerdict;
    partial?: boolean | undefined;
    usptoOk: boolean;
    euipoOk: boolean;
  }): void {
    this.#tmGateObserved = true;
    if (stats.verdict === 'clear') {
      this.#tmGateClear++;
      if (stats.partial) this.#tmGatePartial++;
    } else if (stats.verdict === 'blocked') {
      this.#tmGateBlocked++;
    } else {
      this.#tmGateUnverified++;
    }
    if (!stats.usptoOk) this.#tmGateUsptoFailures++;
    if (!stats.euipoOk) this.#tmGateEuipoFailures++;
  }

  recordProviderError(providerName: string, method: string, errorCode: string): void {
    const existing = this.#providerMetrics.get(providerName) ?? {
      providerName,
      totalCalls: 0,
      totalErrors: 0,
      lastCallDurationMs: null,
      lastErrorAt: null,
      currentErrors: [],
    };
    existing.totalErrors++;
    existing.lastErrorAt = new Date().toISOString();
    const errorMetric: ProviderErrorMetric = {
      providerName,
      method,
      errorCode,
      lastErrorAt: existing.lastErrorAt,
    };
    existing.currentErrors.push(errorMetric);
    if (existing.currentErrors.length > 10) {
      existing.currentErrors = existing.currentErrors.slice(-10);
    }
    this.#providerMetrics.set(providerName, existing);
  }

  recordProviderCall(providerName: string, durationMs: number): void {
    const existing = this.#providerMetrics.get(providerName) ?? {
      providerName,
      totalCalls: 0,
      totalErrors: 0,
      lastCallDurationMs: null,
      lastErrorAt: null,
      currentErrors: [],
    };
    existing.totalCalls++;
    existing.lastCallDurationMs = durationMs;
    this.#providerMetrics.set(providerName, existing);
  }

  /** Record a successful database backup (fed by BackupService.onSuccess). */
  recordBackupSuccess(timestampMs: number): void {
    this.#backupLastSuccessAtMs = timestampMs;
  }

  /** Record the outcome of a pitr-health check (fed by PitrHealthService). */
  recordPitrCheck(metrics: {
    walLagBytes: number | null;
    baseBackupAgeHours: number | null;
    archivingActive: boolean;
    checkedAtMs: number;
  }): void {
    this.#pitrWalLagBytes = metrics.walLagBytes;
    this.#pitrBaseBackupAgeHours = metrics.baseBackupAgeHours;
    this.#pitrArchivingActive = metrics.archivingActive;
    this.#pitrCheckedAtMs = metrics.checkedAtMs;
  }

  /** Record an anonymous trademark budget outcome (ADR-0056): whether the
   *  public scoring namespace obtained a budget slot (true) or failed open
   *  to an 'unverified' verdict (false). */
  recordAnonTrademarkBudget(granted: boolean): void {
    this.#anonTrademarkObserved = true;
    if (granted) this.#anonTrademarkHits++;
    else this.#anonTrademarkBlocked++;
  }

  snapshot(): MetricsSnapshot {
    const stageMetrics: Record<string, StageMetrics> = {};
    for (const [key, value] of this.#stageMetrics) {
      stageMetrics[key] = { ...value };
    }
    const providerMetrics: Record<string, ProviderMetrics> = {};
    for (const [key, value] of this.#providerMetrics) {
      providerMetrics[key] = { ...value, currentErrors: [...value.currentErrors] };
    }
    const mem = process.memoryUsage();

    const histograms: Record<string, HistogramSample> = {};
    for (const [key, sample] of this.#histograms) {
      histograms[key] = {
        ...sample,
        labels: { ...sample.labels },
        bucketCounts: [...sample.bucketCounts],
        bucketsMs: [...sample.bucketsMs],
      };
    }

    return {
      pipeline: {
        totalRuns: this.#totalRuns,
        totalCandidatesEvaluated: this.#totalCandidatesEvaluated,
        totalRecommended: this.#totalRecommended,
        stageMetrics,
        lastRunAt: this.#lastRunAt,
        lastRunDurationMs: this.#lastRunDurationMs,
        providerMetrics,
        dnsConsensus: {
          verifiedTotal: this.#dnsConsensusVerified,
          disagreedTotal: this.#dnsConsensusDisagreed,
          unverifiableTotal: this.#dnsConsensusUnverifiable,
          tertiaryRescuedTotal: this.#dnsConsensusTertiaryRescued,
          degradedRunsTotal: this.#dnsConsensusDegradedRuns,
          lastRunDegraded: this.#dnsConsensusLastDegraded,
          observed: this.#dnsConsensusObserved,
        },
        rdapConsensus: {
          verifiedTotal: this.#rdapConsensusVerified,
          disagreedTotal: this.#rdapConsensusDisagreed,
          unverifiableTotal: this.#rdapConsensusUnverifiable,
          whoisRescuedTotal: this.#rdapConsensusWhoisRescued,
          originOverlapTotal: this.#rdapConsensusOriginOverlap,
          originGuardUnavailableTotal: this.#rdapConsensusOriginGuardUnavailable,
          degradedRunsTotal: this.#rdapConsensusDegradedRuns,
          lastRunDegraded: this.#rdapConsensusLastDegraded,
          observed: this.#rdapConsensusObserved,
        },
        trademarkGate: {
          clearTotal: this.#tmGateClear,
          blockedTotal: this.#tmGateBlocked,
          unverifiedTotal: this.#tmGateUnverified,
          partialTotal: this.#tmGatePartial,
          usptoFailuresTotal: this.#tmGateUsptoFailures,
          euipoFailuresTotal: this.#tmGateEuipoFailures,
          observed: this.#tmGateObserved,
        },
        dnsBreakers: {
          open: this.#dnsBreakerOpen,
          closed: this.#dnsBreakerClosed,
          halfOpen: this.#dnsBreakerHalfOpen,
          total: this.#dnsBreakerTotal,
          observed: this.#dnsBreakersObserved,
        },
      },
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        pid: process.pid,
        version: readVersion(),
        timestamp: new Date().toISOString(),
      },
      backup: {
        lastSuccessAtMs: this.#backupLastSuccessAtMs,
        pitrWalLagBytes: this.#pitrWalLagBytes,
        pitrBaseBackupAgeHours: this.#pitrBaseBackupAgeHours,
        pitrArchivingActive: this.#pitrArchivingActive,
        pitrCheckedAtMs: this.#pitrCheckedAtMs,
      },
      anonTrademark: {
        hitsTotal: this.#anonTrademarkHits,
        blockedTotal: this.#anonTrademarkBlocked,
        observed: this.#anonTrademarkObserved,
      },
      histograms,
      rdapBootstrap: {
        ok: this.#rdapBootstrapOk,
        consecutiveFailures: this.#rdapBootstrapFailures,
        lastSuccessAtMs: this.#rdapBootstrapLastSuccessAtMs,
        nextRetryAtMs: this.#rdapBootstrapNextRetryAtMs,
        observed: this.#rdapBootstrapObserved,
      },
    };
  }

  reset(): void {
    this.#stageMetrics.clear();
    this.#providerMetrics.clear();
    this.#totalRuns = 0;
    this.#totalCandidatesEvaluated = 0;
    this.#totalRecommended = 0;
    this.#lastRunAt = null;
    this.#lastRunDurationMs = null;
    this.#dnsConsensusVerified = 0;
    this.#dnsConsensusDisagreed = 0;
    this.#dnsConsensusUnverifiable = 0;
    this.#dnsConsensusTertiaryRescued = 0;
    this.#dnsConsensusDegradedRuns = 0;
    this.#dnsConsensusLastDegraded = false;
    this.#dnsConsensusObserved = false;
    this.#dnsBreakerOpen = 0;
    this.#dnsBreakerClosed = 0;
    this.#dnsBreakerHalfOpen = 0;
    this.#dnsBreakerTotal = 0;
    this.#dnsBreakersObserved = false;
    this.#rdapConsensusVerified = 0;
    this.#rdapConsensusDisagreed = 0;
    this.#rdapConsensusUnverifiable = 0;
    this.#rdapConsensusWhoisRescued = 0;
    this.#rdapConsensusOriginOverlap = 0;
    this.#rdapConsensusOriginGuardUnavailable = 0;
    this.#rdapConsensusDegradedRuns = 0;
    this.#rdapConsensusLastDegraded = false;
    this.#rdapConsensusObserved = false;
    this.#rdapBootstrapOk = null;
    this.#rdapBootstrapFailures = 0;
    this.#rdapBootstrapLastSuccessAtMs = null;
    this.#rdapBootstrapNextRetryAtMs = null;
    this.#rdapBootstrapObserved = false;
    this.#tmGateClear = 0;
    this.#tmGateBlocked = 0;
    this.#tmGateUnverified = 0;
    this.#tmGatePartial = 0;
    this.#tmGateUsptoFailures = 0;
    this.#tmGateEuipoFailures = 0;
    this.#tmGateObserved = false;
    this.#backupLastSuccessAtMs = null;
    this.#pitrWalLagBytes = null;
    this.#pitrBaseBackupAgeHours = null;
    this.#pitrArchivingActive = null;
    this.#pitrCheckedAtMs = null;
    this.#anonTrademarkHits = 0;
    this.#anonTrademarkBlocked = 0;
    this.#anonTrademarkObserved = false;
    this.#histograms.clear();
  }
}
