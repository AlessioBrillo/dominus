// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { MetricsRepository } from '../../db/repositories/metrics-repository.js';
import type { MetricsCollector } from '../../app/metrics-collector.js';
import type { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import type { MetricsSnapshot } from '../../types/metrics.js';
import type { JobQueueStats } from '../../types/job-queue.js';
import { getRouteParam } from '../route-utils.js';

export function createMetricsRouter(
  metricsRepo: MetricsRepository,
  collector: MetricsCollector,
  jobQueueRepo: JobQueueRepository,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const snapshot = collector.snapshot();
      const aggregates = metricsRepo.getAggregates();
      res.json({
        current: snapshot,
        aggregates,
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get(
    '/prometheus',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        const [queueStats, deadLetterCount] = await Promise.all([
          jobQueueRepo.getStats(),
          jobQueueRepo.countDeadLetter(),
        ]);
        res.send(renderPrometheusMetrics(collector.snapshot(), queueStats, deadLetterCount));
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.get('/runs', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const limitRaw =
        typeof req.query['limit'] === 'string' ? Number.parseInt(req.query['limit'], 10) : 20;
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;
      const history = metricsRepo.findRecentRuns(limit);
      res.json({ runs: history });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get('/runs/:runId', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const runId = getRouteParam(req, 'runId');
      if (!runId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required' } });
        return;
      }
      const stages = metricsRepo.findByRunId(runId);
      res.json({ runId, stages });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}

/** Escape a Prometheus label value per the text exposition format
 *  (backslash, double-quote and newline are the three escapable characters). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

const g = (
  help: string,
  name: string,
  value: string | number,
  labels?: string,
  type: 'gauge' | 'counter' = 'gauge',
): void => {
  const suffix = labels ? `{${labels}}` : '';
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(`${name}${suffix} ${value}`);
};

let lines: string[] = [];

/** Render the collector snapshot + job queue stats in Prometheus text format.
 *  Pure function so it can be unit-tested without booting an Express app. */
export function renderPrometheusMetrics(
  snapshot: MetricsSnapshot,
  queueStats: JobQueueStats,
  deadLetterCount: number,
): string {
  lines = [];

  g(
    'Static information about the running instance.',
    'dominus_app_info',
    1,
    `version="${escapeLabelValue(snapshot.system.version)}"`,
  );
  g('Whether this API process is alive.', 'dominus_up', 1);
  g('Process uptime in seconds.', 'dominus_uptime_seconds', snapshot.system.uptimeSeconds);
  g('Process RSS in megabytes.', 'dominus_memory_usage_mb', snapshot.system.memoryUsageMb);
  g(
    'Pipeline runs since process start.',
    'dominus_pipeline_runs_total',
    snapshot.pipeline.totalRuns,
    undefined,
    'counter',
  );
  g(
    'Candidates evaluated since process start.',
    'dominus_candidates_total',
    snapshot.pipeline.totalCandidatesEvaluated,
    undefined,
    'counter',
  );
  g(
    'Candidates recommended since process start.',
    'dominus_recommended_total',
    snapshot.pipeline.totalRecommended,
    undefined,
    'counter',
  );
  if (snapshot.pipeline.lastRunDurationMs !== null) {
    g(
      'Duration in ms of the last pipeline run.',
      'dominus_last_run_duration_ms',
      snapshot.pipeline.lastRunDurationMs,
    );
  }

  for (const [stageName, stage] of Object.entries(snapshot.pipeline.stageMetrics)) {
    const labels = `stage="${escapeLabelValue(stageName)}"`;
    g(
      'Stage executions since process start.',
      'dominus_stage_runs_total',
      stage.runCount,
      labels,
      'counter',
    );
    g(
      'Candidates passed through the stage.',
      'dominus_stage_passed_total',
      stage.totalPassed,
      labels,
      'counter',
    );
    g(
      'Candidates filtered by the stage.',
      'dominus_stage_filtered_total',
      stage.totalFiltered,
      labels,
      'counter',
    );
    g(
      'Stage runs in error since process start.',
      'dominus_stage_errors_total',
      stage.errorCount,
      labels,
      'counter',
    );
    g(
      'Stage total duration in ms.',
      'dominus_stage_duration_ms_total',
      stage.totalDurationMs,
      labels,
      'counter',
    );
  }

  for (const [providerName, provider] of Object.entries(snapshot.pipeline.providerMetrics)) {
    const labels = `provider="${escapeLabelValue(providerName)}"`;
    g(
      'Provider calls since process start.',
      'dominus_provider_calls_total',
      provider.totalCalls,
      labels,
      'counter',
    );
    g(
      'Provider errors since process start.',
      'dominus_provider_errors_total',
      provider.totalErrors,
      labels,
      'counter',
    );
  }

  g('Jobs currently queued awaiting a worker.', 'dominus_queue_queued', queueStats.queued);
  g('Jobs currently running.', 'dominus_queue_running', queueStats.running);
  g('Jobs completed.', 'dominus_queue_completed_total', queueStats.completed, undefined, 'counter');
  g(
    'Jobs failed (final, from job_queue).',
    'dominus_queue_failed_total',
    queueStats.failed,
    undefined,
    'counter',
  );
  g(
    'Jobs in the dead-letter table.',
    'dominus_queue_dead_letter_total',
    deadLetterCount,
    undefined,
    'counter',
  );

  return `${lines.join('\n')}\n`;
}
