// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostAcquisitionStepContext,
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from './post-acquisition-service.js';
import type { IndexingService } from './indexing-service.js';
import { forSalePagePath } from './site-service.js';

export interface IndexingStepExecutorOptions {
  /** Public origin of this DOMINUS instance (PUBLIC_APP_URL). Required:
   *  IndexNow verifies ownership by hosting the key file on that host. */
  publicAppUrl?: string | undefined;
}

/**
 * `indexing` step of the post-acquisition pipeline (ADR-0083, M2).
 *
 * Submits the for-sale page URL to IndexNow (Bing/Yandex/Seznam). Skips —
 * honestly — when the key is missing, when no public URL is configured
 * (self-hosted without a public origin), or in dry-run mode.
 */
export class IndexingStepExecutor implements PostAcquisitionStepExecutor {
  readonly step = 'indexing' as const;

  readonly #indexing: IndexingService;
  readonly #publicAppUrl: string | undefined;

  constructor(indexing: IndexingService, options: IndexingStepExecutorOptions = {}) {
    this.#indexing = indexing;
    this.#publicAppUrl = options.publicAppUrl;
  }

  async execute(ctx: PostAcquisitionStepContext): Promise<PostAcquisitionStepOutcome> {
    if (ctx.dryRun) {
      return { status: 'skipped', reason: 'dry_run' };
    }
    if (!this.#indexing.isConfigured) {
      return { status: 'skipped', reason: 'indexnow_not_configured' };
    }
    if (this.#publicAppUrl === undefined || this.#publicAppUrl.length === 0) {
      return { status: 'skipped', reason: 'public_app_url_not_configured' };
    }

    const url = `${this.#publicAppUrl.replace(/\/$/, '')}${forSalePagePath(ctx.domain)}`;
    const host = new URL(this.#publicAppUrl).host;

    const [result] = await this.#indexing.submitUrls([url], host);
    if (result === undefined || !result.ok) {
      return { status: 'failed', error: result?.error ?? 'indexnow_submission_failed' };
    }

    return {
      status: 'done',
      message: `submitted to IndexNow (HTTP ${String(result.status)})`,
      detail: { url, host, status: result.status },
    };
  }
}
