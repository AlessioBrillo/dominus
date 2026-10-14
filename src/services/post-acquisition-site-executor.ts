// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostAcquisitionStepContext,
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from './post-acquisition-service.js';
import type { SiteService } from './site-service.js';

/**
 * `site` step of the post-acquisition pipeline (ADR-0083, M2).
 *
 * Publishes the public for-sale page of the acquired domain from the
 * scoring data. The page is the discoverability surface for buyers and the
 * URL the `indexing` step submits. Publishing is free and reversible
 * (`dominus automate reset` + unpublish), so it runs in dry-run too.
 */
export class SiteStepExecutor implements PostAcquisitionStepExecutor {
  readonly step = 'site' as const;

  constructor(private readonly siteService: SiteService) {}

  async execute(_ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome> {
    if (!this.siteService.canBuild) {
      return { status: 'skipped', reason: 'scoring_engine_unavailable' };
    }

    const result = await this.siteService.publish(_ctx.domain);
    return {
      status: 'done',
      message: `for-sale page published at ${result.url}`,
      detail: {
        url: result.url,
        ...(result.askingPriceEur !== null ? { askingPriceEur: result.askingPriceEur } : {}),
      },
    };
  }
}
