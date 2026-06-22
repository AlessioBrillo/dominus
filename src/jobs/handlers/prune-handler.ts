import type Database from 'better-sqlite3';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import type { PrunePayload, PruneResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PruneHandlerDeps {
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  pipelineRunsRepo: PipelineRunsRepository;
  providerCacheRepo: ProviderCacheRepository;
  jobQueueRepo: JobQueueRepository;
  db?: Database.Database;
}

export class PruneHandler implements JobHandler<PrunePayload, PruneResult> {
  readonly jobType = 'PRUNE' as const;

  constructor(private readonly deps: PruneHandlerDeps) {}

  async handle(payload: PrunePayload): Promise<PruneResult> {
    const maxAgeDays = payload.maxAgeDays ?? 30;
    logger.info({ maxAgeDays }, 'PruneHandler: starting prune');

    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    const deletedCandidates = this.deps.candidateRepo.pruneRescoreCandidates(cutoff);
    const deletedScoringRuns = this.deps.scoringRepo.pruneByRunIdPrefix('rescore_', cutoff);
    const deletedPipelineRuns = this.deps.pipelineRunsRepo.pruneBefore(cutoff);
    const deletedProviderCache = this.deps.providerCacheRepo.pruneExpired();
    const deletedJobQueue = this.deps.jobQueueRepo.deleteCompleted(7);
    const deletedWaybackCache = this.deps.db
      ? this.deps.db.prepare("DELETE FROM wayback_cache WHERE expires_at < datetime('now')").run()
          .changes
      : 0;

    logger.info(
      {
        deletedCandidates,
        deletedScoringRuns,
        deletedPipelineRuns,
        deletedProviderCache,
        deletedJobQueue,
        deletedWaybackCache,
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
    };
  }
}
