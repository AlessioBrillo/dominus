// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { ListingStepExecutor } from '../post-acquisition-listing-executor.js';

function mockAutoListingService(): {
  autoList: ReturnType<typeof vi.fn>;
} {
  return { autoList: vi.fn() };
}

const ctx = {
  domain: 'example.com',
  source: 'purchase' as const,
  pipelineRunId: null,
  dryRun: false,
};

describe('ListingStepExecutor', () => {
  it('is the listing step', () => {
    const executor = new ListingStepExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockAutoListingService() as any,
    );
    expect(executor.step).toBe('listing');
  });

  it('maps a completed listing to done', async () => {
    const svc = mockAutoListingService();
    svc.autoList.mockResolvedValue({
      skipped: false,
      listing: { id: 9, marketplace: 'manual', priceEur: 1500 },
      source: 'purchase',
    });

    const outcome = await new ListingStepExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc as any,
    ).execute(ctx);

    expect(svc.autoList).toHaveBeenCalledWith('example.com', null, 'purchase');
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.detail).toEqual({ listingId: 9, marketplace: 'manual', priceEur: 1500 });
    }
  });

  it('maps an already-listed domain to done', async () => {
    const svc = mockAutoListingService();
    svc.autoList.mockResolvedValue({
      skipped: true,
      reason: 'already_listed',
      message: 'already has a manual listing',
    });

    const outcome = await new ListingStepExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc as any,
    ).execute(ctx);

    expect(outcome.status).toBe('done');
  });

  it('maps a listing error to failed so the chain halts', async () => {
    const svc = mockAutoListingService();
    svc.autoList.mockResolvedValue({
      skipped: true,
      reason: 'error',
      message: 'Marketplace API unavailable',
    });

    const outcome = await new ListingStepExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc as any,
    ).execute(ctx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('Marketplace API unavailable');
    }
  });

  it('skips in dry-run and never creates a listing', async () => {
    const svc = mockAutoListingService();

    const outcome = await new ListingStepExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc as any,
    ).execute({ ...ctx, dryRun: true });

    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('dry_run');
    }
    expect(svc.autoList).not.toHaveBeenCalled();
  });
});
