import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { WeightSnapshotRepository } from '../../db/repositories/weight-snapshot-repository.js';
import { AutoWeightTuner } from '../auto-tuner.js';
import type { AutoTunerConfig } from '../auto-tuner-config.js';
import type { BacktestEngine } from '../backtest/backtest-engine.js';
import type { WeightSuggester } from '../backtest/weight-suggester.js';
import type { Notifier } from '../../notifiers/notifier.js';
import type { WeightSuggestionReport } from '../backtest/types.js';
import { DEFAULT_WEIGHTS } from '../weights.js';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_WEIGHTS_PATH = join(process.cwd(), 'data', 'test-weights-override.json');

function makeSuggestionReport(
  overrides: Partial<WeightSuggestionReport> = {},
): WeightSuggestionReport {
  return {
    generatedAt: new Date().toISOString(),
    sampleSize: 25,
    totalCurrentWeight: 1,
    totalSuggestedWeight: 1,
    sumsToOne: true,
    warnings: [],
    suggestions: [
      {
        signal: 'intrinsic',
        currentWeight: DEFAULT_WEIGHTS.intrinsic,
        suggestedWeight: DEFAULT_WEIGHTS.intrinsic + 0.02,
        delta: 0.02,
        action: 'apply',
        rationale: 'test rationale intrinsic',
      },
      {
        signal: 'commercial',
        currentWeight: DEFAULT_WEIGHTS.commercial,
        suggestedWeight: DEFAULT_WEIGHTS.commercial - 0.02,
        delta: -0.02,
        action: 'revert',
        rationale: 'test rationale commercial',
      },
      {
        signal: 'market',
        currentWeight: DEFAULT_WEIGHTS.market,
        suggestedWeight: DEFAULT_WEIGHTS.market,
        delta: 0,
        action: 'hold',
        rationale: 'test rationale market',
      },
      {
        signal: 'expiry',
        currentWeight: DEFAULT_WEIGHTS.expiry,
        suggestedWeight: DEFAULT_WEIGHTS.expiry,
        delta: 0,
        action: 'hold',
        rationale: 'test rationale expiry',
      },
    ],
    ...overrides,
  };
}

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('AutoWeightTuner', () => {
  let db: Database.Database;
  let weightSnapshotRepo: WeightSnapshotRepository;
  let mockBacktestEngine: BacktestEngine;
  let mockWeightSuggester: WeightSuggester;
  let mockNotifier: Notifier;

  beforeEach(() => {
    db = openTestDb();
    const dbProvider = new SqliteProvider(db);
    weightSnapshotRepo = new WeightSnapshotRepository(dbProvider);

    mockBacktestEngine = {
      snapshot: vi.fn().mockReturnValue({ scanned: 10, inserted: 5, skipped: 2 }),
    } as unknown as BacktestEngine;

    mockWeightSuggester = {
      suggest: vi.fn(),
    } as unknown as WeightSuggester;

    mockNotifier = {
      channel: 'console' as const,
      send: vi.fn().mockResolvedValue(undefined),
    };

    if (existsSync(TEST_WEIGHTS_PATH)) {
      try {
        unlinkSync(TEST_WEIGHTS_PATH);
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_WEIGHTS_PATH)) {
      try {
        unlinkSync(TEST_WEIGHTS_PATH);
      } catch {
        /* ignore */
      }
    }
  });

  const defaultConfig: AutoTunerConfig = {
    enabled: true,
    minSampleSize: 20,
    maxDeltaPerSignal: 0.05,
    maxTotalDriftFromDefaults: 0.2,
    dryRun: true,
  };

  it('returns a valid AutoTuneOutcome with dryRun=true', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      defaultConfig,
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome).toBeDefined();
    expect(outcome.dryRun).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.sampleSize).toBe(25);
    expect(outcome.suggestions).toHaveLength(4);
    expect(outcome.safety.passed).toBe(true);
    expect(outcome.safety.failures).toHaveLength(0);
    expect(outcome.snapshotId).toBeTypeOf('number');
  });

  it('does not write the override file in dry-run mode', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, dryRun: true },
      TEST_WEIGHTS_PATH,
    );

    tuner.tune();

    expect(existsSync(TEST_WEIGHTS_PATH)).toBe(false);
  });

  it('writes the override file when not in dry-run and safety passes', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, dryRun: false },
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.applied).toBe(true);
    expect(existsSync(TEST_WEIGHTS_PATH)).toBe(true);
  });

  it('fails safety when sample size is below minimum', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport({ sampleSize: 5 }));

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, minSampleSize: 20 },
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.safety.passed).toBe(false);
    expect(outcome.safety.failures[0]).toBe('Sample size 5 < minimum 20');
    expect(outcome.applied).toBe(false);
  });

  it('fails safety when a signal delta exceeds maxDeltaPerSignal', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(
      makeSuggestionReport({
        suggestions: [
          {
            signal: 'intrinsic',
            currentWeight: 0.3,
            suggestedWeight: 0.5,
            delta: 0.2,
            action: 'apply',
            rationale: 'large delta test',
          },
          {
            signal: 'commercial',
            currentWeight: 0.35,
            suggestedWeight: 0.25,
            delta: -0.1,
            action: 'revert',
            rationale: 'large delta test',
          },
          {
            signal: 'market',
            currentWeight: 0.25,
            suggestedWeight: 0.15,
            delta: -0.1,
            action: 'revert',
            rationale: 'large delta test',
          },
          {
            signal: 'expiry',
            currentWeight: 0.1,
            suggestedWeight: 0.1,
            delta: 0,
            action: 'hold',
            rationale: 'unchanged',
          },
        ],
      }),
    );

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, maxDeltaPerSignal: 0.05 },
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.safety.passed).toBe(false);
    expect(outcome.safety.failures.length).toBeGreaterThanOrEqual(1);
  });

  it('fails safety when suggested weights do not sum to one', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(
      makeSuggestionReport({ sumsToOne: false, totalSuggestedWeight: 0.95 }),
    );

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      defaultConfig,
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.safety.passed).toBe(false);
    expect(outcome.safety.failures[0]).toBe('Suggested weights sum to 0.9500 (expected 1.0)');
  });

  it('persists a weight_snapshot record on every tune call', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      defaultConfig,
      TEST_WEIGHTS_PATH,
    );

    const before = weightSnapshotRepo.count();
    tuner.tune();
    const after = weightSnapshotRepo.count();

    expect(after).toBe(before + 1);
  });

  it('sends notification when weights are applied', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, dryRun: false },
      TEST_WEIGHTS_PATH,
      [mockNotifier],
    );

    tuner.tune();

    expect(mockNotifier.send).toHaveBeenCalledTimes(1);
    expect(mockNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'auto-tuner',
        alertType: 'score_dropped',
      }),
    );
  });

  it('does not send notification when weights are not applied (dry run)', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(makeSuggestionReport());

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      { ...defaultConfig, dryRun: true },
      TEST_WEIGHTS_PATH,
      [mockNotifier],
    );

    tuner.tune();

    expect(mockNotifier.send).not.toHaveBeenCalled();
  });

  it('includes warnings when all signals are on hold', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(
      makeSuggestionReport({
        suggestions: [
          {
            signal: 'intrinsic',
            currentWeight: 0.3,
            suggestedWeight: 0.3,
            delta: 0,
            action: 'hold',
            rationale: 'no change needed',
          },
          {
            signal: 'commercial',
            currentWeight: 0.35,
            suggestedWeight: 0.35,
            delta: 0,
            action: 'hold',
            rationale: 'no change needed',
          },
          {
            signal: 'market',
            currentWeight: 0.25,
            suggestedWeight: 0.25,
            delta: 0,
            action: 'hold',
            rationale: 'no change needed',
          },
          {
            signal: 'expiry',
            currentWeight: 0.1,
            suggestedWeight: 0.1,
            delta: 0,
            action: 'hold',
            rationale: 'no change needed',
          },
        ],
      }),
    );

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      defaultConfig,
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.warnings).toContain('All signals on hold — no weight changes recommended');
  });

  it('records warnings from the suggestion report', () => {
    vi.mocked(mockWeightSuggester.suggest).mockReturnValue(
      makeSuggestionReport({
        warnings: ['Sample is skewed towards .com domains'],
      }),
    );

    const tuner = new AutoWeightTuner(
      mockBacktestEngine,
      mockWeightSuggester,
      weightSnapshotRepo,
      DEFAULT_WEIGHTS,
      defaultConfig,
      TEST_WEIGHTS_PATH,
    );

    const outcome = tuner.tune();

    expect(outcome.warnings).toContain('Sample is skewed towards .com domains');
  });
});
