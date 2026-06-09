import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type BacktestEngine } from './backtest/backtest-engine.js';
import { type WeightSuggester } from './backtest/weight-suggester.js';
import type { ScoringWeights } from './weights.js';
import { DEFAULT_WEIGHTS } from './weights.js';
import type { WeightSnapshotRepository } from '../db/repositories/weight-snapshot-repository.js';
import type { AutoTunerConfig } from './auto-tuner-config.js';
import { DEFAULT_AUTO_TUNER_CONFIG } from './auto-tuner-config.js';

export interface AutoTuneOutcome {
  tunedAt: string;
  dryRun: boolean;
  sampleSize: number;
  snapshot: { scanned: number; inserted: number; skipped: number };
  suggestions: Array<{
    signal: string;
    currentWeight: number;
    suggestedWeight: number;
    delta: number;
    action: string;
    rationale: string;
  }>;
  safety: {
    passed: boolean;
    checks: string[];
    failures: string[];
  };
  applied: boolean;
  snapshotId: number | null;
  warnings: string[];
}

const DEFAULT_OVERRIDE_PATH = './data/weights-override.json';

export class AutoWeightTuner {
  constructor(
    private readonly backtestEngine: BacktestEngine,
    private readonly weightSuggester: WeightSuggester,
    private readonly weightSnapshotRepo: WeightSnapshotRepository,
    private readonly currentWeights: ScoringWeights,
    private readonly config: AutoTunerConfig = DEFAULT_AUTO_TUNER_CONFIG,
    private readonly overridePath: string = DEFAULT_OVERRIDE_PATH,
  ) {}

  tune(): AutoTuneOutcome {
    const tunedAt = new Date().toISOString();
    const warnings: string[] = [];

    // 1. Snapshot backtest signals
    const snapshot = this.backtestEngine.snapshot();

    // 2. Run weight suggester
    const suggestionReport = this.weightSuggester.suggest();
    if (suggestionReport.warnings.length > 0) {
      warnings.push(...suggestionReport.warnings);
    }

    const sampleSize = suggestionReport.sampleSize;

    // 3. Safety validation
    const checks: string[] = [];
    const failures: string[] = [];

    // 3a. Minimum sample size
    if (sampleSize < this.config.minSampleSize) {
      failures.push(`Sample size ${sampleSize} < minimum ${this.config.minSampleSize}`);
    } else {
      checks.push(`Sample size ${sampleSize} >= ${this.config.minSampleSize}`);
    }

    // 3b. Per-signal delta limits
    for (const s of suggestionReport.suggestions) {
      const absDelta = Math.abs(s.delta);
      if (absDelta > this.config.maxDeltaPerSignal) {
        failures.push(
          `${s.signal} delta ${absDelta.toFixed(3)} > max ${this.config.maxDeltaPerSignal}`,
        );
      } else {
        checks.push(`${s.signal} delta ${absDelta.toFixed(3)} <= ${this.config.maxDeltaPerSignal}`);
      }
    }

    // 3c. Total drift from defaults
    const totalDrift =
      Math.abs(this.currentWeights.intrinsic - DEFAULT_WEIGHTS.intrinsic) +
      Math.abs(this.currentWeights.commercial - DEFAULT_WEIGHTS.commercial) +
      Math.abs(this.currentWeights.market - DEFAULT_WEIGHTS.market) +
      Math.abs(this.currentWeights.expiry - DEFAULT_WEIGHTS.expiry);
    if (totalDrift > this.config.maxTotalDriftFromDefaults) {
      failures.push(
        `Total drift from defaults ${totalDrift.toFixed(3)} > max ${this.config.maxTotalDriftFromDefaults}`,
      );
    } else {
      checks.push(
        `Total drift from defaults ${totalDrift.toFixed(3)} <= ${this.config.maxTotalDriftFromDefaults}`,
      );
    }

    // 3d. Sums to one (from suggester validation)
    if (!suggestionReport.sumsToOne) {
      failures.push(
        `Suggested weights sum to ${suggestionReport.totalSuggestedWeight.toFixed(4)} (expected 1.0)`,
      );
    } else {
      checks.push('Suggested weights sum to 1.0');
    }

    // 3e. Any non-hold suggestions must be valid
    const nonHold = suggestionReport.suggestions.filter((s) => s.action !== 'hold');
    if (nonHold.length === 0 && sampleSize >= this.config.minSampleSize) {
      warnings.push('All signals on hold — no weight changes recommended');
    }

    const safetyPassed = failures.length === 0;
    let applied = false;

    // 4. Apply if safe and not dry run
    if (safetyPassed && !this.config.dryRun) {
      this.writeOverrideFile(suggestionReport);
      applied = true;
    }

    // 5. Record in weight_snapshots (always — even dry runs)
    const newWeights = this.resolveNewWeights(suggestionReport, safetyPassed);
    const record = this.weightSnapshotRepo.insert({
      intrinsic: newWeights.intrinsic,
      commercial: newWeights.commercial,
      market: newWeights.market,
      expiry: newWeights.expiry,
      source: 'auto-tune',
      backtestGeneratedAt: tunedAt,
      sampleSize,
      notes: this.buildNotes(safetyPassed, applied, warnings, failures),
    });
    const snapshotId = record.id;

    return {
      tunedAt,
      dryRun: this.config.dryRun,
      sampleSize,
      snapshot,
      suggestions: suggestionReport.suggestions.map((s) => ({
        signal: s.signal,
        currentWeight: s.currentWeight,
        suggestedWeight: s.suggestedWeight,
        delta: s.delta,
        action: s.action,
        rationale: s.rationale,
      })),
      safety: {
        passed: safetyPassed,
        checks,
        failures,
      },
      applied,
      snapshotId,
      warnings,
    };
  }

  private writeOverrideFile(report: {
    suggestions: Array<{ signal: string; suggestedWeight: number }>;
  }): void {
    const absPath = resolve(process.cwd(), this.overridePath);
    if (!absPath.startsWith(resolve(process.cwd(), './data'))) {
      return;
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      sampleSize: report.suggestions.reduce((acc, s) => acc + (s.suggestedWeight > 0 ? 1 : 0), 0),
      weights: Object.fromEntries(report.suggestions.map((s) => [s.signal, s.suggestedWeight])),
    };
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }

  private resolveNewWeights(
    report: {
      suggestions: Array<{ signal: string; suggestedWeight: number }>;
    },
    safetyPassed: boolean,
  ): ScoringWeights {
    const out = { ...this.currentWeights };
    if (safetyPassed) {
      for (const s of report.suggestions) {
        const key = s.signal as keyof ScoringWeights;
        out[key] = s.suggestedWeight;
      }
    }
    return out;
  }

  private buildNotes(
    safetyPassed: boolean,
    applied: boolean,
    warnings: string[],
    failures: string[],
  ): string {
    const parts: string[] = [];
    if (safetyPassed) {
      parts.push('safety checks passed');
    } else {
      parts.push(`safety checks failed: ${failures.join('; ')}`);
    }
    if (applied) {
      parts.push('weights written to override file');
    }
    if (warnings.length > 0) {
      parts.push(`warnings: ${warnings.join('; ')}`);
    }
    return parts.join('. ');
  }
}
