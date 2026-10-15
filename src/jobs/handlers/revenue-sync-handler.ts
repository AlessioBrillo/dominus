// SPDX-License-Identifier: AGPL-3.0-only
import type { JobHandler, RevenueSyncPayload, RevenueSyncResult } from '../../types/job-queue.js';
import type { RevenueIngestionService } from '../../services/revenue-ingestion-service.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface RevenueSyncHandlerDeps {
  revenueIngestionService: RevenueIngestionService;
}

/**
 * Handles REVENUE_SYNC jobs — the scheduled ingestion of ad revenue
 * (ADR-0083, M5). Ingestion is a read (ADR-0083 amendment): it records
 * what the monetization provider reports, idempotently, and never
 * mutates external state. With no provider configured the job records
 * zero and reports `provider: null` — it never invents revenue.
 */
export class RevenueSyncHandler implements JobHandler<RevenueSyncPayload, RevenueSyncResult> {
  readonly jobType = 'REVENUE_SYNC' as const;

  constructor(private readonly deps: RevenueSyncHandlerDeps) {}

  async handle(payload: RevenueSyncPayload): Promise<RevenueSyncResult> {
    const ingestion = this.deps.revenueIngestionService;

    if (!ingestion.isConfigured) {
      logger.info('RevenueSyncHandler: no monetization provider configured — nothing to ingest');
      return { recorded: 0, domains: 0, provider: null };
    }

    const result = await ingestion.ingestAll(payload.since);

    logger.info(
      { recorded: result.recorded, domains: result.domains.length, since: payload.since },
      'RevenueSyncHandler: complete',
    );

    return {
      recorded: result.recorded,
      domains: result.domains.length,
      provider: ingestion.providerName,
    };
  }
}
