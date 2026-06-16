import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { JobQueueService } from '../../app/job-queue-service.js';
import type { PipelineProgressService } from '../../app/pipeline-progress-service.js';
import { setupSseResponse } from '../../app/pipeline-progress-service.js';
import type { Database } from 'better-sqlite3';
import type { CandidateGenerationInput } from '../../pipeline/stages/candidate-generation-stage.js';
import { getRouteParam } from '../route-utils.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * REST surface for the pipeline_runs history (ADR-0011).
 *
 * Routes (mounted at /api/runs):
 *   GET    /                  → list (newest first, ?since, ?until, ?limit)
 *   POST   /                  → submit a pipeline run (sync or async via job queue)
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
  runService?: PipelineRunService,
  jobQueueService?: JobQueueService,
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

  /**
   * POST / — Submit a pipeline run.
   *
   * Body: { keywords?: string[], brandableNames?: string[], closeoutDomains?: string[] }
   *
   * When jobQueueService is available, returns 202 Accepted with runId and jobId.
   * Otherwise runs synchronously and returns 200 with the full PipelineRunResult.
   */
  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { keywords, brandableNames, closeoutDomains } = req.body ?? {};

      if (
        !Array.isArray(keywords) &&
        !Array.isArray(brandableNames) &&
        !Array.isArray(closeoutDomains)
      ) {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message:
              'Provide at least one of: keywords (string[]), brandableNames (string[]), closeoutDomains (string[])',
          },
        });
        return;
      }

      const input: CandidateGenerationInput = {
        keywords: Array.isArray(keywords) ? keywords.filter(Boolean) : undefined,
        brandableNames: Array.isArray(brandableNames) ? brandableNames.filter(Boolean) : undefined,
        closeoutDomains: Array.isArray(closeoutDomains)
          ? closeoutDomains.filter(Boolean)
          : undefined,
      };

      if (jobQueueService && runService) {
        // Async path: enqueue and return 202
        void jobQueueService.enqueuePipelineRun(input).then(({ jobId, runId }) => {
          res.status(202).json({
            runId,
            jobId,
            status: 'queued',
          });
        });
        return;
      }

      if (!runService) {
        res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message:
              'Pipeline run service is not available. Start the server with a valid configuration.',
          },
        });
        return;
      }

      // Sync path: run synchronously and return 200
      runService
        .run(input)
        .then((result) => {
          res.status(200).json({
            runId: result.runId,
            status: 'completed',
            durationMs: result.totalDurationMs,
            recommended: result.recommended.length,
            scored: result.scored.length,
            stageSummary: result.stageSummary,
            stageErrors: result.stageErrors,
            persistence: result.persistence,
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err }, 'POST /api/runs — sync pipeline run failed');
          res.status(500).json({
            error: { code: 'PIPELINE_RUN_FAILED', message },
          });
        });
    } catch (err: unknown) {
      next(err);
    }
  });

  /**
   * GET /:runId/job — Return the job queue status for a submitted run.
   * This route must be registered BEFORE the generic /:runId route.
   */
  router.get('/:runId/job', (req: Request, res: Response, next: NextFunction): void => {
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

      if (!jobQueueService) {
        res.json({ runId, jobStatus: 'not_available' });
        return;
      }

      // The run was created synchronously — no job tracking needed
      if (run.finishedAt !== null) {
        res.json({ runId, jobStatus: 'completed', finishedAt: run.finishedAt });
        return;
      }

      res.json({ runId, jobStatus: 'in_progress' });
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
