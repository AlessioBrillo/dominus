// SPDX-License-Identifier: AGPL-3.0-only
import type { JobHandler, RevenueSyncPayload, RevenueSyncResult } from '../../types/job-queue.js';
import type { RevenueIngestionService } from '../../services/revenue-ingestion-service.js';
import { getTenantId } from '../../utils/tenant-context.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface RevenueSyncHandlerDeps {
  revenueIngestionService: RevenueIngestionService;
  /**
   * True on DOMINUS Cloud (multi-tenant). A cron-fired job carries no
   * tenant context: without this guard every tenant's revenue would be
   * written under the `default` tenant, mixing tenants and leaving the
   * real ones without revenue data. On a multi-tenant deployment the job
   * refuses instead — per-tenant fan-out is a roadmap item, never silent
   * cross-tenant writes.
   */
  multiTenant?: boolean;
}

/**
 * Handles REVENUE_SYNC jobs — the scheduled ingestion of ad revenue
 * (ADR-0083, M5). Ingestion is a read: it records what the monetization
 * provider reports, idempotently, and never mutates external state. With
 * no provider configured the job records zero and reports so honestly —
 * it never invents revenue.
 */
export class RevenueSyncHandler implements JobHandler<RevenueSyncPayload, RevenueSyncResult> {
  readonly jobType = 'REVENUE_SYNC' as const;

  constructor(private readonly deps: RevenueSyncHandlerDeps) {}

  async handle(payload: RevenueSyncPayload): Promise<RevenueSyncResult> {
    const ingestion = this.deps.revenueIngestionService;

    if (this.deps.multiTenant === true && getTenantId() === undefined) {
      logger.warn(
        'RevenueSyncHandler: refusing to run without tenant context on a multi-tenant deployment (would mix tenants under the default tenant)',
      );
      return { recorded: 0, domains: 0, provider: null };
    }

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
