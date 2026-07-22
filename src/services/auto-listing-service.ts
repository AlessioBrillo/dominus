import type { ListingManager } from '../listing/listing-manager.js';
import type { ScoreResult } from '../types/score.js';
import type { MarketplaceName, Listing } from '../types/listing.js';
import type { AutoListSource } from '../types/listing.js';
export type { AutoListSource } from '../types/listing.js';
import type { AutoListingRepository } from '../db/repositories/auto-listing-repository.js';
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

export class AutoListingService {
  readonly #listingManager: ListingManager;
  readonly #autoListingRepo: AutoListingRepository;

  constructor(listingManager: ListingManager, autoListingRepo: AutoListingRepository) {
    this.#listingManager = listingManager;
    this.#autoListingRepo = autoListingRepo;
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
      const listing = await this.#listingManager.listDomain(domain, mkt, score?.suggestedListPrice);

      const scoreSnapshotJson = score ? JSON.stringify(score) : null;

      await this.#autoListingRepo.insert({
        domain,
        listingId: listing.id,
        triggerSource: source,
        pipelineRunId: pipelineRunId ?? null,
        scoreSnapshotJson: scoreSnapshotJson ?? null,
      });

      logger.info(
        { domain, listingId: listing.id, source },
        'AutoListingService: auto-listing recorded',
      );

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
    signal?: AbortSignal,
  ): Promise<{ listed: AutoListResult[]; skipped: AutoListSkipped[] }> {
    const listed: AutoListResult[] = [];
    const skipped: AutoListSkipped[] = [];

    for (const { domain, score } of domains) {
      if (signal?.aborted) {
        logger.warn(
          { listed: listed.length, skipped: skipped.length, source },
          'AutoListingService: batch auto-list aborted early',
        );
        return { listed, skipped };
      }
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
