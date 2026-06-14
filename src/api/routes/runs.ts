import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { PipelineProgressService } from '../../app/pipeline-progress-service.js';
import { setupSseResponse } from '../../app/pipeline-progress-service.js';
import type { Database } from 'better-sqlite3';
import { getRouteParam } from '../route-utils.js';

/**
 * REST surface for the pipeline_runs history (ADR-0011).
 *
 * Routes (mounted at /api/runs):
 *   GET    /                  → list (newest first, ?since, ?until, ?limit)
 *   GET    /:runId            → one run with stage + result summary
 *   GET    /:runId/candidates → candidates persisted during that run
 *   GET    /:runId/stream     → SSE: live stage progress for a running pipeline
 *   POST   /prune             → delete expired runs; returns { deleted, remaining }
 */
export function createRunsRouter(
  runsRepo: PipelineRunsRepository,
  candidateRepo: CandidateRepository,
  scoringRepo: ScoringRepository,
  db?: Database,
  progressService?: PipelineProgressService,
): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const since = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
      const until = typeof req.query['until'] === 'string' ? req.query['until'] : undefined;
      const limitRaw =
        typeof req.query['limit'] === 'string'
          ? Number.parseInt(req.query['limit'], 10)
          : undefined;
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      const opts: { since?: string; until?: string; limit?: number } = {};
      if (since !== undefined) opts.since = since;
      if (until !== undefined) opts.until = until;
      if (limit !== undefined) opts.limit = limit;
      const runs = runsRepo.findAll(opts);
      res.json({ runs });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/:runId', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const runId = getRouteParam(req, 'runId');
      if (runId === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required' } });
        return;
      }
      const run = runsRepo.findById(runId);
      if (run === null) {
        res
          .status(404)
          .json({ error: { code: 'RUN_NOT_FOUND', message: `No pipeline run with id ${runId}` } });
        return;
      }
      res.json({ run });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/:runId/candidates', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const runId = getRouteParam(req, 'runId');
      if (runId === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required' } });
        return;
      }
      const run = runsRepo.findById(runId);
      if (run === null) {
        res
          .status(404)
          .json({ error: { code: 'RUN_NOT_FOUND', message: `No pipeline run with id ${runId}` } });
        return;
      }
      const candidates = candidateRepo.findByRunId(runId);
      res.json({ runId, candidates });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/:runId/stream', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const runId = getRouteParam(req, 'runId');
      if (runId === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required' } });
        return;
      }
      if (!progressService) {
        res
          .status(501)
          .json({ error: { code: 'SSE_UNAVAILABLE', message: 'SSE progress is not available' } });
        return;
      }
      setupSseResponse(res);
      progressService.addClient(runId, res);
      req.on('close', () => {
        // client disconnected — progressService handles cleanup
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.post('/prune', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const before = runsRepo.count();
      const deleted = runsRepo.prune();
      res.json({ deleted, remaining: before - deleted });
    } catch (err: unknown) {
      next(err);
    }
  });

  // The scoringRepo and db parameters are accepted for symmetry with the
  // composition root and to give future endpoints (e.g. /:runId/scores) a
  // place to plug in without changing the call site. They are intentionally
  // not used yet.
  void scoringRepo;
  void db;

  return router;
}
