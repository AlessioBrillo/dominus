// SPDX-License-Identifier: AGPL-3.0-only
import type { ListingManager } from '../listing/listing-manager.js';
import type { ScoreResult } from '../types/score.js';
import type { MarketplaceName, Listing } from '../types/listing.js';
import type { AutoListSource } from '../types/listing.js';
export type { AutoListSource } from '../types/listing.js';
import type { AutoListingRepository } from '../db/repositories/auto-listing-repository.js';
import type { TenantListingSettingsRepository } from '../db/repositories/tenant-listing-settings-repository.js';
import { getLogger } from '../logger.js';
import { isTransient, computeDelay, defaultSleep } from '../providers/retry-policy.js';

export interface AutoListEnqueuer {
  enqueue(domain: string, source: AutoListSource, scoreJson?: string | null): Promise<string>;
}

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
  readonly #listingSettingsRepo: TenantListingSettingsRepository | undefined;

  constructor(
    listingManager: ListingManager,
    autoListingRepo: AutoListingRepository,
    listingSettingsRepo?: TenantListingSettingsRepository,
  ) {
    this.#listingManager = listingManager;
    this.#autoListingRepo = autoListingRepo;
    this.#listingSettingsRepo = listingSettingsRepo;
  }

  /**
   * Resolve the listing price for a new automatic listing (ADR-0083, M4):
   * the tenant's fixed base price when the policy says so, otherwise the
   * conservative price the scoring engine computed.
   */
  async #resolvePrice(score: ScoreResult | null): Promise<number | undefined> {
    if (this.#listingSettingsRepo !== undefined) {
      const settings = await this.#listingSettingsRepo.get();
      if (settings.pricePolicy === 'fixed' && settings.basePriceEur !== null) {
        return settings.basePriceEur;
      }
    }
    return score?.suggestedListPrice;
  }

  async autoList(
    domain: string,
    score: ScoreResult | null,
    source: AutoListSource,
    pipelineRunId?: string,
    marketplace?: MarketplaceName,
  ): Promise<AutoListOutcome> {
    const mkt = marketplace ?? DEFAULT_MARKETPLACE;
    const price = await this.#resolvePrice(score);

    const existing = await this.#listingManager.getListings({ domain });
    const alreadyOnTarget = existing.find((l) => l.marketplace === mkt);
    if (alreadyOnTarget) {
      return {
        skipped: true,
        reason: 'already_listed',
        message: `Domain ${domain} already has a ${mkt} listing (status: ${alreadyOnTarget.status})`,
      };
    }

    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const listing = await this.#listingManager.listDomain(domain, mkt, price);

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
        lastError = err;
        if (attempt < maxRetries && isTransient(err)) {
          const delay = computeDelay(
            attempt,
            {
              maxAttempts: maxRetries,
              baseDelayMs: 250,
              backoffMultiplier: 2,
              maxDelayMs: 4000,
              jitterRatio: 1,
            },
            Math.random,
          );
          logger.warn(
            { domain, attempt, maxRetries, delayMs: delay, err },
            'AutoListingService: transient failure — retrying',
          );
          await defaultSleep(delay);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    logger.error(
      { domain, err: lastError },
      'AutoListingService: failed to auto-list domain after retries',
    );
    return { skipped: true, reason: 'error', message };
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
