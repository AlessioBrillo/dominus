import type Database from 'better-sqlite3';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { PrunePayload, PruneResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PruneHandlerDeps {
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  pipelineRunsRepo: PipelineRunsRepository;
  providerCacheRepo: ProviderCacheRepository;
  jobQueueRepo: JobQueueRepository;
  /** Raw SQLite connection for wayback_cache cleanup. null when using PostgreSQL. */
  db: Database.Database | null;
  /** DatabaseProvider for cross-dialect queries (public_scores, events). */
  provider: DatabaseProvider;
  /** Retention days for public_score entries (default: 90). */
  publicScoresRetentionDays: number;
  /** Retention days for events entries (default: 180). */
  eventsRetentionDays: number;
}

export class PruneHandler implements JobHandler<PrunePayload, PruneResult> {
  readonly jobType = 'PRUNE' as const;

  constructor(private readonly deps: PruneHandlerDeps) {}

  async handle(payload: PrunePayload): Promise<PruneResult> {
    const maxAgeDays = payload.maxAgeDays ?? 30;
    logger.info({ maxAgeDays }, 'PruneHandler: starting prune');

    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    const deletedCandidates = await this.deps.candidateRepo.pruneRescoreCandidates(cutoff);
    const deletedScoringRuns = await this.deps.scoringRepo.pruneByRunIdPrefix('rescore_', cutoff);
    const deletedPipelineRuns = await this.deps.pipelineRunsRepo.pruneBefore(cutoff);
    const deletedProviderCache = await this.deps.providerCacheRepo.pruneExpired();
    const deletedJobQueue = await this.deps.jobQueueRepo.deleteCompleted(7);
    const deletedWaybackCache = this.deps.db
      ? this.deps.db.prepare("DELETE FROM wayback_cache WHERE expires_at < datetime('now')").run()
          .changes
      : 0;

    const publicScoresCutoff = new Date(
      Date.now() - this.deps.publicScoresRetentionDays * 86400000,
    ).toISOString();
    const deletedPublicScores = (
      await this.deps.provider.exec('DELETE FROM public_scores WHERE created_at < ?', [
        publicScoresCutoff,
      ])
    ).changes;

    const eventsCutoff = new Date(
      Date.now() - this.deps.eventsRetentionDays * 86400000,
    ).toISOString();
    const deletedEvents = (
      await this.deps.provider.exec('DELETE FROM events WHERE created_at < ?', [eventsCutoff])
    ).changes;

    logger.info(
      {
        deletedCandidates,
        deletedScoringRuns,
        deletedPipelineRuns,
        deletedProviderCache,
        deletedJobQueue,
        deletedWaybackCache,
        deletedPublicScores,
        deletedEvents,
      },
      'PruneHandler: completed',
    );

    return {
      deletedCandidates,
      deletedScoringRuns,
      deletedPipelineRuns,
      deletedProviderCache,
      deletedJobQueue,
      deletedWaybackCache,
      deletedPublicScores,
      deletedEvents,
    };
  }
}
