import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { BacktestEngine, WeightSuggester } from '../../scoring/backtest/index.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { ScoringWeights } from '../../scoring/weights.js';
import { DEFAULT_WEIGHTS } from '../../scoring/weights.js';
import type { AutoWeightTuner } from '../../scoring/auto-tuner.js';

export function createBacktestRouter(
  db: Database.Database,
  outcomeRepo: OutcomeRepository,
  currentWeights: ScoringWeights = DEFAULT_WEIGHTS,
  autoTuner?: AutoWeightTuner,
): Router {
  const router = Router();
  const provider = new SqliteProvider(db);
  const backtestSignalsRepo = new BacktestSignalsRepository(provider);
  const scoringRepo = new ScoringRepository(provider);

  router.post('/snapshot', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const engine = new BacktestEngine(db, outcomeRepo, backtestSignalsRepo);
      const summary = engine.snapshot();
      res.json(summary);
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/report', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const engine = new BacktestEngine(db, outcomeRepo, backtestSignalsRepo);
      const report = engine.report();
      res.json(report);
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/suggest-weights', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const suggester = new WeightSuggester(db, backtestSignalsRepo, scoringRepo, currentWeights);
      const report = suggester.suggest();
      res.json(report);
    } catch (err: unknown) {
      next(err);
    }
  });

  if (autoTuner) {
    router.post('/auto-tune', (_req: Request, res: Response, next: NextFunction): void => {
      try {
        const outcome = autoTuner.tune();
        res.json(outcome);
      } catch (err: unknown) {
        next(err);
      }
    });
  }

  return router;
}
