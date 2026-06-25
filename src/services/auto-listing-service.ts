import type { ListingManager } from '../listing/listing-manager.js';
import type { ScoreResult } from '../types/score.js';
import type { MarketplaceName, Listing } from '../types/listing.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

const DEFAULT_MARKETPLACE: MarketplaceName = 'manual';

export interface AutoListResult {
  listing: Listing;
  source: AutoListSource;
  skipped: false;
}

export interface AutoListSkipped {
  skipped: true;
  reason: 'already_listed' | 'error';
  message: string;
}

export type AutoListOutcome = AutoListResult | AutoListSkipped;

export type AutoListSource = 'acquisition' | 'purchase' | 'pipeline_run';

export class AutoListingService {
  readonly #listingManager: ListingManager;
  readonly #db: DatabaseProvider;

  constructor(listingManager: ListingManager, db: DatabaseProvider) {
    this.#listingManager = listingManager;
    this.#db = db;
  }

  async autoList(
    domain: string,
    score: ScoreResult | null,
    source: AutoListSource,
    pipelineRunId?: string,
    marketplace?: MarketplaceName,
  ): Promise<AutoListOutcome> {
    const mkt = marketplace ?? DEFAULT_MARKETPLACE;

    const existing = await this.#listingManager.getListings({ domain });
    const alreadyOnTarget = existing.find((l) => l.marketplace === mkt);
    if (alreadyOnTarget) {
      return {
        skipped: true,
        reason: 'already_listed',
        message: `Domain ${domain} already has a ${mkt} listing (status: ${alreadyOnTarget.status})`,
      };
    }

    try {
      // ListingManager prices via engine internally if no price provided
      const listing = await this.#listingManager.listDomain(domain, mkt, score?.suggestedListPrice);

      const scoreJson = score ? JSON.stringify(score) : null;

      const insertResult = await this.#db.exec(
        `INSERT INTO auto_listings (domain, listing_id, trigger_source, pipeline_run_id, score_snapshot_json, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [domain, listing.id, source, pipelineRunId ?? null, scoreJson],
      );
      if (insertResult.lastInsertRowid) {
        logger.info(
          { domain, listingId: listing.id, source },
          'AutoListingService: auto-listing recorded',
        );
      }

      return { listing, source, skipped: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ domain, err }, 'AutoListingService: failed to auto-list domain');
      return { skipped: true, reason: 'error', message };
    }
  }

  async autoListBatch(
    domains: Array<{ domain: string; score: ScoreResult | null }>,
    source: AutoListSource,
    pipelineRunId?: string,
    marketplace?: MarketplaceName,
  ): Promise<{ listed: AutoListResult[]; skipped: AutoListSkipped[] }> {
    const listed: AutoListResult[] = [];
    const skipped: AutoListSkipped[] = [];

    for (const { domain, score } of domains) {
      const outcome = await this.autoList(domain, score, source, pipelineRunId, marketplace);
      if (outcome.skipped) {
        skipped.push(outcome);
      } else {
        listed.push(outcome);
      }
    }

    logger.info(
      { listed: listed.length, skipped: skipped.length, source },
      'AutoListingService: batch auto-list complete',
    );

    return { listed, skipped };
  }
}
