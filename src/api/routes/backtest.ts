import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import { BacktestEngine, WeightSuggester } from '../../scoring/backtest/index.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { ScoringWeights } from '../../scoring/weights.js';
import { DEFAULT_WEIGHTS } from '../../scoring/weights.js';
import type { AutoWeightTuner } from '../../scoring/auto-tuner.js';

export function createBacktestRouter(
  provider: DatabaseProvider,
  outcomeRepo: OutcomeRepository,
  currentWeights: ScoringWeights = DEFAULT_WEIGHTS,
  autoTuner?: AutoWeightTuner,
): Router {
  const router = Router();
  const backtestSignalsRepo = new BacktestSignalsRepository(provider);
  const scoringRepo = new ScoringRepository(provider);

  router.post(
    '/snapshot',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const engine = new BacktestEngine(provider, outcomeRepo, backtestSignalsRepo);
        const summary = await engine.snapshot();
        res.json(summary);
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.post(
    '/report',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const engine = new BacktestEngine(provider, outcomeRepo, backtestSignalsRepo);
        const report = await engine.report();
        res.json(report);
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.post(
    '/suggest-weights',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const suggester = new WeightSuggester(
          provider,
          backtestSignalsRepo,
          scoringRepo,
          currentWeights,
        );
        const report = await suggester.suggest();
        res.json(report);
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  if (autoTuner) {
    router.post(
      '/auto-tune',
      async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const outcome = await autoTuner.tune();
          res.json(outcome);
        } catch (err: unknown) {
          next(err);
        }
      },
    );
  }

  return router;
}
