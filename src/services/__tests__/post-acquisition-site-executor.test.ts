// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { SiteStepExecutor } from '../post-acquisition-site-executor.js';
import { IndexingStepExecutor } from '../post-acquisition-indexing-executor.js';
import { IndexingService } from '../indexing-service.js';

const ctx = {
  domain: 'vintagecoffee.com',
  source: 'purchase' as const,
  pipelineRunId: null,
  dryRun: false,
};

describe('SiteStepExecutor', () => {
  it('is the site step', () => {
    const executor = new SiteStepExecutor({ canBuild: true } as never);
    expect(executor.step).toBe('site');
  });

  it('publishes the page and reports the URL', async () => {
    const siteService = {
      canBuild: true,
      publish: vi.fn().mockResolvedValue({
        site: {},
        url: '/public/for-sale/vintagecoffee.com',
        askingPriceEur: 1200,
      }),
    };

    const outcome = await new SiteStepExecutor(siteService as never).execute(ctx);

    expect(siteService.publish).toHaveBeenCalledWith('vintagecoffee.com');
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.detail).toEqual({
        url: '/public/for-sale/vintagecoffee.com',
        askingPriceEur: 1200,
      });
    }
  });

  it('skips when the scoring engine is unavailable', async () => {
    const siteService = { canBuild: false, publish: vi.fn() };
    const outcome = await new SiteStepExecutor(siteService as never).execute(ctx);
    expect(outcome).toEqual({ status: 'skipped', reason: 'scoring_engine_unavailable' });
    expect(siteService.publish).not.toHaveBeenCalled();
  });

  it('runs even in dry-run (publishing is free and reversible)', async () => {
    const siteService = {
      canBuild: true,
      publish: vi
        .fn()
        .mockResolvedValue({ site: {}, url: '/public/for-sale/x.com', askingPriceEur: null }),
    };
    const outcome = await new SiteStepExecutor(siteService as never).execute({
      ...ctx,
      dryRun: true,
    });
    expect(outcome.status).toBe('done');
  });
});

describe('IndexingStepExecutor', () => {
  it('is the indexing step', () => {
    expect(new IndexingStepExecutor(new IndexingService({})).step).toBe('indexing');
  });

  it('skips in dry-run mode', async () => {
    const indexing = new IndexingService({ indexNowKey: 'abc123def456abc123def456' });
    const outcome = await new IndexingStepExecutor(indexing, {
      publicAppUrl: 'https://dominus.app',
    }).execute({ ...ctx, dryRun: true });
    expect(outcome).toEqual({ status: 'skipped', reason: 'dry_run' });
  });

  it('skips when no IndexNow key is configured', async () => {
    const outcome = await new IndexingStepExecutor(new IndexingService({}), {
      publicAppUrl: 'https://dominus.app',
    }).execute(ctx);
    expect(outcome).toEqual({ status: 'skipped', reason: 'indexnow_not_configured' });
  });

  it('skips when no public URL is configured (self-hosted)', async () => {
    const indexing = new IndexingService({ indexNowKey: 'abc123def456abc123def456' });
    const outcome = await new IndexingStepExecutor(indexing).execute(ctx);
    expect(outcome).toEqual({ status: 'skipped', reason: 'public_app_url_not_configured' });
  });

  it('submits the for-sale page URL to IndexNow', async () => {
    let submittedBody: { host: string; urlList: string[] } | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      submittedBody = JSON.parse(String(init?.body)) as { host: string; urlList: string[] };
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    const indexing = new IndexingService({
      indexNowKey: 'abc123def456abc123def456',
      fetchImpl,
    });

    const outcome = await new IndexingStepExecutor(indexing, {
      publicAppUrl: 'https://dominus.app',
    }).execute(ctx);

    expect(submittedBody?.host).toBe('dominus.app');
    expect(submittedBody?.urlList).toEqual([
      'https://dominus.app/public/for-sale/vintagecoffee.com',
    ]);
    expect(outcome.status).toBe('done');
  });

  it('fails the step when the submission is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 403 }) as unknown as typeof fetch;
    const indexing = new IndexingService({
      indexNowKey: 'abc123def456abc123def456',
      fetchImpl,
    });

    const outcome = await new IndexingStepExecutor(indexing, {
      publicAppUrl: 'https://dominus.app',
    }).execute(ctx);

    expect(outcome.status).toBe('failed');
  });
});
