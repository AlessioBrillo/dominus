// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import type { AutomationAuditRepository } from '../../db/repositories/automation-audit-repository.js';
import type { SignupVerificationRepository } from '../../db/repositories/signup-verification-repository.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { PrunePayload, PruneResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';
import { sqlTimestamp } from '../../db/sql-timestamp.js';

const logger = getLogger();

export interface PruneHandlerDeps {
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  pipelineRunsRepo: PipelineRunsRepository;
  providerCacheRepo: ProviderCacheRepository;
  jobQueueRepo: JobQueueRepository;
  /** Automation audit trail retention (default: 90). Optional: the audit
   *  table only exists on installations that ran migration 0061. */
  automationAuditRepo?: AutomationAuditRepository | undefined;
  /** Expired signup/recovery tokens. Optional: the table exists on every
   *  installation that ran migration 0067. */
  signupVerificationRepo?: SignupVerificationRepository | undefined;
  /** Raw SQLite connection for wayback_cache cleanup. null when using PostgreSQL. */
  db: Database.Database | null;
  /** DatabaseProvider for cross-dialect queries (public_scores, events). */
  provider: DatabaseProvider;
  /** Retention days for public_score entries (default: 90). */
  publicScoresRetentionDays: number;
  /** Retention days for events entries (default: 180). */
  eventsRetentionDays: number;
  /** Retention days for automation_audit entries (default: 90). */
  automationAuditRetentionDays?: number;
  /** Days a workspace may stay unverified before it is removed (default: 7). */
  unverifiedTenantRetentionDays?: number;
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
    // Raw better-sqlite3 handle; absent (0) on PostgreSQL deployments.
    const deletedWaybackCache = this.deps.db
      ? this.deps.db.prepare('DELETE FROM wayback_cache WHERE expires_at < ?').run(sqlTimestamp())
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

    const auditRetentionDays = this.deps.automationAuditRetentionDays ?? 90;
    const deletedAutomationAudit = this.deps.automationAuditRepo
      ? await this.deps.automationAuditRepo.pruneOlderThan(
          new Date(Date.now() - auditRetentionDays * 86400000).toISOString(),
        )
      : 0;

    // The tokens of the signup verification and of the key recovery expire:
    // an expired token must not stay usable.
    const deletedVerifications = this.deps.signupVerificationRepo
      ? await this.deps.signupVerificationRepo.deleteExpired()
      : 0;

    // A workspace whose address was never proven is an inert tenant: it
    // holds a subscription row, a pending seat and a token. Nobody can use
    // it, and it would stay there forever. After the retention window it
    // is removed.
    const unverifiedRetentionDays = this.deps.unverifiedTenantRetentionDays ?? 7;
    const unverifiedCutoff = new Date(
      Date.now() - unverifiedRetentionDays * 86400000,
    ).toISOString();
    const deletedUnverifiedTenants = this.deps.signupVerificationRepo
      ? await this.deps.signupVerificationRepo.deleteUnverifiedWorkspaces(unverifiedCutoff)
      : 0;

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
        deletedAutomationAudit,
        deletedVerifications,
        deletedUnverifiedTenants,
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
      deletedAutomationAudit,
    };
  }
}
