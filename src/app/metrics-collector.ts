import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  MetricsSnapshot,
  StageMetrics,
  ProviderMetrics,
  ProviderErrorMetric,
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
      },
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        pid: process.pid,
        version: readVersion(),
        timestamp: new Date().toISOString(),
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
  }
}
