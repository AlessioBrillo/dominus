// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { MetricsRepository } from '../../db/repositories/metrics-repository.js';
import type { MetricsCollector } from '../../app/metrics-collector.js';
import type { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import type { MetricsSnapshot } from '../../types/metrics.js';
import type { HistogramSample } from '../../types/metrics.js';
import type { JobQueueStats } from '../../types/job-queue.js';
import { getRouteParam } from '../route-utils.js';

export interface MetricsRouterOptions {
  /**
   * Optional bearer token. When set, /api/v1/metrics/* requires
   * `Authorization: Bearer <token>`; otherwise requests are rejected with
   * 401. When unset, metrics stay public (backward compatible, matching the
   * pre-token behaviour where a reverse proxy was responsible for access
   * control).
   */
  token?: string;
}

export function createMetricsRouter(
  metricsRepo: MetricsRepository,
  collector: MetricsCollector,
  jobQueueRepo: JobQueueRepository,
  options?: MetricsRouterOptions,
): Router {
  const router = Router();
  const requireToken = options?.token !== undefined && options.token.length > 0;

  // Metrics expose operational telemetry (job queue stats, dead letters,
  // run history) that should not be readable from the public interface.
  // When a token is configured, gate the whole router with a timing-safe
  // Bearer comparison — mirroring the API-key timing-safe policy.
  if (requireToken) {
    const token = options!.token!;
    router.use((req: Request, res: Response, next: NextFunction): void => {
      const header = req.headers['authorization'];
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } });
        return;
      }
      const presented = header.slice('Bearer '.length);
      if (!constantTimeTokenEquals(presented, token)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid bearer token' } });
        return;
      }
      next();
    });
  }

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

/** Render a histogram sample in the text exposition format: one line per
 *  fixed bucket (`le`), then +Inf (equal to the sample count), `_sum` and
 *  `_count` (ADR-0064). */
const h = (help: string, name: string, sample: HistogramSample): void => {
  const base = Object.entries(sample.labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  const prefix = base !== '' ? `${base},` : '';
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  for (let i = 0; i < sample.bucketsMs.length; i++) {
    lines.push(
      `${name}_bucket{${prefix}le="${sample.bucketsMs[i] ?? ''}"} ${sample.bucketCounts[i] ?? 0}`,
    );
  }
  lines.push(`${name}_bucket{${prefix}le="+Inf"} ${sample.count}`);
  lines.push(`${name}_sum{${base}} ${sample.sum}`);
  lines.push(`${name}_count{${base}} ${sample.count}`);
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

  const consensus = snapshot.pipeline.dnsConsensus;
  if (consensus !== undefined && consensus.observed) {
    g(
      '2-of-3 DNS consensus verdicts verified (confirmed Available).',
      'dominus_dns_consensus_verified_total',
      consensus.verifiedTotal,
      undefined,
      'counter',
    );
    g(
      '2-of-3 DNS consensus definitive disagreements (secondary Registered).',
      'dominus_dns_consensus_disagreed_total',
      consensus.disagreedTotal,
      undefined,
      'counter',
    );
    g(
      '2-of-3 DNS consensus domains the secondary could not answer.',
      'dominus_dns_consensus_unverifiable_total',
      consensus.unverifiableTotal,
      undefined,
      'counter',
    );
    g(
      'Available verdicts rescued by the tertiary DNS opinion (ADR-0045).',
      'dominus_dns_consensus_tertiary_rescued_total',
      consensus.tertiaryRescuedTotal,
      undefined,
      'counter',
    );
    g(
      'Runs flagged degraded over DNS consensus (ADR-0039).',
      'dominus_dns_consensus_degraded_runs_total',
      consensus.degradedRunsTotal,
      undefined,
      'counter',
    );
    g(
      '1 when the last consensus-checked run was degraded, else 0.',
      'dominus_dns_consensus_last_run_degraded',
      consensus.lastRunDegraded ? 1 : 0,
      undefined,
      'gauge',
    );
  }

  const dnsBreakers = snapshot.pipeline.dnsBreakers;
  if (dnsBreakers !== undefined && dnsBreakers.observed) {
    g(
      'DNS circuit-breaker endpoints currently open (ADR-0059).',
      'dominus_dns_breaker_open',
      dnsBreakers.open,
      undefined,
      'gauge',
    );
    g(
      'DNS circuit-breaker endpoints currently closed.',
      'dominus_dns_breaker_closed',
      dnsBreakers.closed,
      undefined,
      'gauge',
    );
    g(
      'DNS circuit-breaker endpoints currently half-open (cooldown probe).',
      'dominus_dns_breaker_half_open',
      dnsBreakers.halfOpen,
      undefined,
      'gauge',
    );
    g(
      'DNS circuit-breaker endpoints tracked in total.',
      'dominus_dns_breaker_total',
      dnsBreakers.total,
      undefined,
      'gauge',
    );
  }

  const rdapConsensus = snapshot.pipeline.rdapConsensus;
  if (rdapConsensus !== undefined && rdapConsensus.observed) {
    g(
      '2-of-2 RDAP consensus verdicts verified (confirmed Available).',
      'dominus_rdap_consensus_verified_total',
      rdapConsensus.verifiedTotal,
      undefined,
      'counter',
    );
    g(
      '2-of-2 RDAP consensus definitive disagreements (second leg Registered).',
      'dominus_rdap_consensus_disagreed_total',
      rdapConsensus.disagreedTotal,
      undefined,
      'counter',
    );
    g(
      '2-of-2 RDAP consensus domains the second leg could not answer.',
      'dominus_rdap_consensus_unverifiable_total',
      rdapConsensus.unverifiableTotal,
      undefined,
      'counter',
    );
    g(
      'Available verdicts rescued by the WHOIS rescue leg (ADR-0051).',
      'dominus_rdap_consensus_whois_rescued_total',
      rdapConsensus.whoisRescuedTotal,
      undefined,
      'counter',
    );
    g(
      'Verdicts skipped on per-TLD origin overlap (ADR-0058).',
      'dominus_rdap_consensus_origin_overlap_total',
      rdapConsensus.originOverlapTotal,
      undefined,
      'counter',
    );
    g(
      'Verdicts downgraded on origin-guard resolver failure (ADR-0060).',
      'dominus_rdap_consensus_origin_guard_unavailable_total',
      rdapConsensus.originGuardUnavailableTotal,
      undefined,
      'counter',
    );
    g(
      'Runs flagged degraded over RDAP consensus.',
      'dominus_rdap_consensus_degraded_runs_total',
      rdapConsensus.degradedRunsTotal,
      undefined,
      'counter',
    );
    g(
      '1 when the last consensus-checked run was degraded, else 0.',
      'dominus_rdap_consensus_last_run_degraded',
      rdapConsensus.lastRunDegraded ? 1 : 0,
      undefined,
      'gauge',
    );
  }

  const rdapBootstrap = snapshot.rdapBootstrap;
  if (rdapBootstrap !== undefined && rdapBootstrap.observed) {
    g(
      '1 when the last IANA RDAP bootstrap refresh succeeded, else 0 (ADR-0058).',
      'dominus_rdap_bootstrap_ok',
      rdapBootstrap.ok ? 1 : 0,
      undefined,
      'gauge',
    );
    g(
      'Consecutive failed IANA RDAP bootstrap refresh attempts (ADR-0058).',
      'dominus_rdap_bootstrap_failures_total',
      rdapBootstrap.consecutiveFailures,
      undefined,
      'counter',
    );
  }

  const tmGate = snapshot.pipeline.trademarkGate;
  if (tmGate !== undefined && tmGate.observed) {
    g(
      'Trademark gate checks cleared since process start.',
      'dominus_trademark_gate_clear_total',
      tmGate.clearTotal,
      undefined,
      'counter',
    );
    g(
      'Trademark gate checks blocked (trademark match) since process start.',
      'dominus_trademark_gate_blocked_total',
      tmGate.blockedTotal,
      undefined,
      'counter',
    );
    g(
      'Trademark gate checks unverified (sources down) since process start.',
      'dominus_trademark_gate_unverified_total',
      tmGate.unverifiedTotal,
      undefined,
      'counter',
    );
    g(
      'Trademark gate clear verdicts relying on a single source.',
      'dominus_trademark_gate_partial_total',
      tmGate.partialTotal,
      undefined,
      'counter',
    );
    g(
      'Trademark gate checks where the USPTO source failed.',
      'dominus_trademark_gate_uspto_failures_total',
      tmGate.usptoFailuresTotal,
      undefined,
      'counter',
    );
    g(
      'Trademark gate checks where the EUIPO source failed.',
      'dominus_trademark_gate_euipo_failures_total',
      tmGate.euipoFailuresTotal,
      undefined,
      'counter',
    );
  }

  const anonTm = snapshot.anonTrademark;
  if (anonTm !== undefined && anonTm.observed) {
    g(
      'Anonymous trademark checks executed since process start.',
      'dominus_anon_trademark_hits_total',
      anonTm.hitsTotal,
      undefined,
      'counter',
    );
    g(
      'Anonymous trademark checks failed open to unverified (budget exhausted) since process start.',
      'dominus_anon_trademark_blocked_total',
      anonTm.blockedTotal,
      undefined,
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

  const backup = snapshot.backup;
  if (backup !== undefined) {
    if (backup.lastSuccessAtMs !== null) {
      g(
        'Unix timestamp (seconds) of the last successful database backup; alerts on staleness.',
        'dominus_backup_last_success_timestamp',
        Math.floor(backup.lastSuccessAtMs / 1000),
      );
    }
    if (backup.pitrCheckedAtMs !== null) {
      g(
        'PostgreSQL WAL archiving lag in bytes at the last pitr-health check.',
        'dominus_pitr_wal_lag_bytes',
        backup.pitrWalLagBytes ?? 0,
      );
      g(
        'Age in hours of the newest PostgreSQL base backup at the last pitr-health check.',
        'dominus_pitr_base_backup_age_hours',
        backup.pitrBaseBackupAgeHours ?? -1,
      );
      g(
        '1 when PostgreSQL WAL archiving confirmed at least one archived segment, else 0.',
        'dominus_pitr_archiving_active',
        backup.pitrArchivingActive ? 1 : 0,
      );
    }
  }

  // SLO latency histograms (ADR-0064): per-leg DNS resolution times and
  // per-server RDAP request times, labelled so percentiles can be split by
  // transport/endpoint/verdict/role and by RDAP server.
  for (const sample of Object.values(snapshot.histograms ?? {})) {
    if (sample.name === 'dominus_dns_leg_duration_ms') {
      h(
        'Resolver leg duration in ms, labelled by transport/endpoint/verdict/role.',
        sample.name,
        sample,
      );
    } else if (sample.name === 'dominus_rdap_request_duration_ms') {
      h('RDAP request duration in ms per server and outcome.', sample.name, sample);
    } else {
      h('Latency histogram sample.', sample.name, sample);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Constant-time comparison of a presented token against the configured
 *  one: no early exit on length or prefix mismatch, so a failed attempt
 *  takes the same wall time as a success and leaks nothing about the
 *  secret (same policy as EnvApiKeyProvider). */
function constantTimeTokenEquals(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  let diff = a.length ^ b.length;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
