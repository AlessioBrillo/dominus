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
} from '../types/metrics.js';

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
        trademarkGate: {
          clearTotal: this.#tmGateClear,
          blockedTotal: this.#tmGateBlocked,
          unverifiedTotal: this.#tmGateUnverified,
          partialTotal: this.#tmGatePartial,
          usptoFailuresTotal: this.#tmGateUsptoFailures,
          euipoFailuresTotal: this.#tmGateEuipoFailures,
          observed: this.#tmGateObserved,
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
  }
}
