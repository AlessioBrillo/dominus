// SPDX-License-Identifier: AGPL-3.0-only
import type { AutoListingService } from './auto-listing-service.js';
import type {
  PostAcquisitionStepContext,
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from './post-acquisition-service.js';

/**
 * `listing` step of the post-acquisition pipeline (ADR-0083).
 *
 * Delegates to the existing AutoListingService, which already owns
 * marketplace deduplication, scoring-based pricing and retries. The
 * mapping is deliberate:
 *  - listed              → done
 *  - already listed      → done (the desired end state already holds)
 *  - error               → failed (halts the chain so it is visible)
 */
export class ListingStepExecutor implements PostAcquisitionStepExecutor {
  readonly step = 'listing' as const;

  constructor(private readonly autoListingService: AutoListingService) {}

  async execute(ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome> {
    const outcome = await this.autoListingService.autoList(ctx.domain, null, ctx.source);

    if (!outcome.skipped) {
      return {
        status: 'done',
        message: `listed on ${outcome.listing.marketplace} for ${outcome.listing.priceEur} EUR`,
        detail: {
          listingId: outcome.listing.id,
          marketplace: outcome.listing.marketplace,
          priceEur: outcome.listing.priceEur,
        },
      };
    }

    if (outcome.reason === 'already_listed') {
      return { status: 'done', message: outcome.message };
    }

    return { status: 'failed', error: outcome.message };
  }
}
