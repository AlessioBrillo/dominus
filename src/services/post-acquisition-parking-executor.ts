// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostAcquisitionStepContext,
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from './post-acquisition-service.js';
import type { RevenueIngestionService } from './revenue-ingestion-service.js';

/** Fallback start date when the domain has no revenue recorded yet: everything. */
const INGEST_FROM_BEGINNING = '0000-01-01';

/**
 * `parking` step of the post-acquisition pipeline (ADR-0083, M3).
 *
 * Revenue ingestion is a READ, not a write (ADR-0083 amendment
 * 2026-10-14): the step records what the monetization provider reports
 * for the domain, idempotently, and never mutates external state.
 *
 * Outcomes:
 *  - dry-run                              -> skipped 'dry_run'
 *  - no monetization source configured     -> skipped 'monetization_provider_unavailable'
 *    (honest: the community edition ships a CSV provider, and provider
 *    API adapters land only with verified access, ADR-0082)
 *  - provider error                        -> failed (visible, retryable)
 *  - ingested                              -> done, with the recorded
 *    figures in the journal detail
 */
export class ParkingStepExecutor implements PostAcquisitionStepExecutor {
  readonly step = 'parking' as const;

  readonly #ingestion: RevenueIngestionService;

  constructor(ingestion: RevenueIngestionService) {
    this.#ingestion = ingestion;
  }

  async execute(ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome> {
    if (ctx.dryRun) {
      return { status: 'skipped', reason: 'dry_run' };
    }
    if (!this.#ingestion.isConfigured) {
      return {
        status: 'skipped',
        reason: 'monetization_provider_unavailable',
        detail: {
          note: 'No monetization source is configured: set MONETIZATION_PROVIDER and MONETIZATION_REVENUE_PATH (or wait for a verified provider API adapter).',
        },
      };
    }

    const since = (await this.#ingestion.lastRecordDate(ctx.domain)) ?? INGEST_FROM_BEGINNING;

    try {
      const result = await this.#ingestion.ingestDomain(ctx.domain, since);
      return {
        status: 'done',
        message: `revenue recorded: €${result.totalEur.toFixed(2)} total`,
        detail: {
          provider: this.#ingestion.providerName,
          recorded: result.recorded,
          totalEur: result.totalEur,
          last30DaysEur: result.last30DaysEur,
          since,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: message };
    }
  }
}
