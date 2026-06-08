import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { BacktestEngine, WeightSuggester } from '../../scoring/backtest/index.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { ScoringWeights } from '../../scoring/weights.js';
import { DEFAULT_WEIGHTS } from '../../scoring/weights.js';

export function createBacktestRouter(
  db: Database.Database,
  outcomeRepo: OutcomeRepository,
  currentWeights: ScoringWeights = DEFAULT_WEIGHTS,
): Router {
  const router = Router();
  const backtestSignalsRepo = new BacktestSignalsRepository(db);
  const scoringRepo = new ScoringRepository(db);

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

  return router;
}
