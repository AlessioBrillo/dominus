import type { BacktestEngine } from '../../scoring/backtest/backtest-engine.js';
import type { WeightSuggester } from '../../scoring/backtest/weight-suggester.js';
import type { ScoringWeights } from '../../scoring/weights.js';
import type {
  BacktestBuildPayload,
  BacktestBuildResult,
  JobHandler,
} from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface BacktestHandlerDeps {
  backtestEngine: BacktestEngine;
  weightSuggester: WeightSuggester;
  currentWeights: ScoringWeights;
}

export class BacktestBuildHandler implements JobHandler<BacktestBuildPayload, BacktestBuildResult> {
  readonly jobType = 'BACKTEST_BUILD' as const;

  constructor(private readonly deps: BacktestHandlerDeps) {}

  async handle(payload: BacktestBuildPayload): Promise<BacktestBuildResult> {
    const minSampleSize = payload.minSampleSize ?? 5;

    logger.info({ minSampleSize }, 'BacktestBuildHandler: building signals');

    const snapshotResult = await this.deps.backtestEngine.snapshot();
    const signalsBuilt = snapshotResult.inserted;

    logger.info({ signalsBuilt }, 'BacktestBuildHandler: signals built');

    if (signalsBuilt >= minSampleSize) {
      logger.info('BacktestBuildHandler: suggesting weights');
      const suggestion = await this.deps.weightSuggester.suggest();
      return {
        signalsBuilt,
        weightSuggestion: {
          suggestedWeights: Object.fromEntries(
            suggestion.suggestions.map((s) => [s.signal, s.suggestedWeight]),
          ),
          deltas: Object.fromEntries(
            suggestion.suggestions.map((s) => [s.signal, s.suggestedWeight - s.currentWeight]),
          ),
          sampleSize: suggestion.sampleSize,
        },
      };
    }

    logger.info(
      { signalsBuilt, minSampleSize },
      'BacktestBuildHandler: insufficient samples for weight suggestion',
    );
    return { signalsBuilt };
  }
}
