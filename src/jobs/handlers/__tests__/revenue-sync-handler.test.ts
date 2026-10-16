// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { RevenueSyncHandler } from '../revenue-sync-handler.js';
import type { RevenueIngestionService } from '../../../services/revenue-ingestion-service.js';

function fakeIngestion(
  options: { configured: boolean; recorded?: number } = { configured: true },
): {
  isConfigured: boolean;
  providerName: string | null;
  ingestAll: ReturnType<typeof vi.fn>;
} {
  return {
    isConfigured: options.configured,
    providerName: options.configured ? 'csv' : null,
    ingestAll: vi.fn(async () => ({
      recorded: options.recorded ?? 3,
      domains: ['vintagecoffee.com', 'coffeemill.com'],
    })),
  };
}

describe('RevenueSyncHandler', () => {
  it('records what the provider reports', async () => {
    const ingestion = fakeIngestion({ configured: true, recorded: 3 });
    const handler = new RevenueSyncHandler({
      revenueIngestionService: ingestion as unknown as RevenueIngestionService,
    });

    const result = await handler.handle({ since: '2026-07-01' });

    expect(result).toEqual({ recorded: 3, domains: 2, provider: 'csv' });
    expect(ingestion.ingestAll).toHaveBeenCalledWith('2026-07-01');
  });

  it('reports zero without a configured provider — never invents revenue', async () => {
    const ingestion = fakeIngestion({ configured: false });
    const handler = new RevenueSyncHandler({
      revenueIngestionService: ingestion as unknown as RevenueIngestionService,
    });

    const result = await handler.handle({ since: '2026-07-01' });

    expect(result).toEqual({ recorded: 0, domains: 0, provider: null });
    expect(ingestion.ingestAll).not.toHaveBeenCalled();
  });

  it('has the REVENUE_SYNC job type', () => {
    const handler = new RevenueSyncHandler({
      revenueIngestionService: fakeIngestion() as unknown as RevenueIngestionService,
    });
    expect(handler.jobType).toBe('REVENUE_SYNC');
  });

  it('refuses to run without a tenant context on a multi-tenant deployment', async () => {
    const ingestion = fakeIngestion({ configured: true });
    const handler = new RevenueSyncHandler({
      revenueIngestionService: ingestion as unknown as RevenueIngestionService,
      multiTenant: true,
    });

    const result = await handler.handle({ since: '2026-07-01' });

    // Honest zero: never mix tenants under the default tenant.
    expect(result).toEqual({ recorded: 0, domains: 0, provider: null });
    expect(ingestion.ingestAll).not.toHaveBeenCalled();
  });

  it('runs on a single-tenant deployment without a tenant context', async () => {
    const ingestion = fakeIngestion({ configured: true });
    const handler = new RevenueSyncHandler({
      revenueIngestionService: ingestion as unknown as RevenueIngestionService,
    });

    const result = await handler.handle({ since: '2026-07-01' });

    expect(result.recorded).toBe(3);
    expect(ingestion.ingestAll).toHaveBeenCalledWith('2026-07-01');
  });
});
