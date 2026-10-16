// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { RevenueIngestionService } from '../revenue-ingestion-service.js';
import { ParkingStepExecutor } from '../post-acquisition-parking-executor.js';
import type { MonetizationProvider, RevenueRecord } from '../../types/monetization.js';
import type { MonetizationRevenueRepository } from '../../db/repositories/monetization-revenue-repository.js';

/** In-memory stand-in for the repository contract the service uses. */
function fakeRepo(options: { lastDate?: string | null } = {}): MonetizationRevenueRepository {
  const stored = new Map<string, RevenueRecord>();
  return {
    stored,
    lastRecordDate: vi.fn(async () => options.lastDate ?? null),
    record: vi.fn(async (r: RevenueRecord) => {
      stored.set(`${r.domain}|${r.date}|${r.source}`, r);
      return 1;
    }),
    recordAll: vi.fn(async (records: RevenueRecord[]) => {
      for (const r of records) {
        stored.set(`${r.domain}|${r.date}|${r.source}`, r);
      }
      return records.length;
    }),
    findByDomain: vi.fn(async () => [...stored.values()]),
    totalSince: vi.fn(async () => 0),
    summarize: vi.fn(async (domain: string) => {
      const rows = [...stored.values()].filter((r) => r.domain === domain);
      return {
        domain,
        totalEur: rows.reduce((s, r) => s + r.amountEur, 0),
        last30DaysEur: rows.reduce((s, r) => s + r.amountEur, 0),
        lastRecordDate: rows.length > 0 ? rows[rows.length - 1]!.date : null,
        records: rows.length,
      };
    }),
  } as unknown as MonetizationRevenueRepository;
}

function fakeProvider(records: RevenueRecord[], available = true): MonetizationProvider {
  return {
    name: 'fake',
    isAvailable: available,
    fetchRevenue: vi.fn(async (since: string) => records.filter((r) => r.date >= since)),
  };
}

const record = (date: string, amountEur: number): RevenueRecord => ({
  domain: 'vintagecoffee.com',
  date,
  amountEur,
  source: 'fake',
  fetchedAt: '2026-10-06T00:00:00Z',
});

describe('RevenueIngestionService', () => {
  it('reports not configured when the provider is absent', () => {
    const service = new RevenueIngestionService({ provider: undefined, repo: fakeRepo() });
    expect(service.isConfigured).toBe(false);
    expect(service.providerName).toBeNull();
  });

  it('reports not configured when the provider is unavailable', () => {
    const service = new RevenueIngestionService({
      provider: fakeProvider([], false),
      repo: fakeRepo(),
    });
    expect(service.isConfigured).toBe(false);
  });

  it('ingests a domain idempotently and reports the totals', async () => {
    const repo = fakeRepo({ lastDate: '2026-10-01' }) as MonetizationRevenueRepository & {
      stored: Map<string, RevenueRecord>;
    };
    const service = new RevenueIngestionService({
      provider: fakeProvider([record('2026-10-01', 1.25), record('2026-10-02', 0.75)]),
      repo,
    });

    const result = await service.ingestDomain('vintagecoffee.com', '2026-10-01');

    expect(result.recorded).toBe(2);
    expect(result.totalEur).toBeCloseTo(2.0, 5);
    expect(result.skipped).toBeNull();
    expect(repo.stored.size).toBe(2);

    // A re-run with the same records updates the same keys.
    await service.ingestDomain('vintagecoffee.com', '2026-10-01');
    expect(repo.stored.size).toBe(2);
  });

  it('ingestAll groups records by domain', async () => {
    const repo = fakeRepo();
    const provider = fakeProvider([
      record('2026-10-01', 1.0),
      { ...record('2026-10-01', 2.0), domain: 'other.com' },
    ]);
    const service = new RevenueIngestionService({ provider, repo });

    const result = await service.ingestAll('2026-01-01');

    expect(result.recorded).toBe(2);
    expect(result.domains.sort()).toEqual(['other.com', 'vintagecoffee.com']);
  });
});

describe('ParkingStepExecutor', () => {
  const ctx = {
    domain: 'vintagecoffee.com',
    source: 'purchase' as const,
    pipelineRunId: null,
    dryRun: false,
  };

  it('skips in dry-run', async () => {
    const executor = new ParkingStepExecutor(
      new RevenueIngestionService({
        provider: fakeProvider([record('2026-10-01', 1)]),
        repo: fakeRepo(),
      }),
    );

    const outcome = await executor.execute({ ...ctx, dryRun: true });

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe('dry_run');
  });

  it('skips honestly when no monetization source is configured', async () => {
    const executor = new ParkingStepExecutor(
      new RevenueIngestionService({ provider: undefined, repo: fakeRepo() }),
    );

    const outcome = await executor.execute(ctx);

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe(
      'monetization_provider_unavailable',
    );
    expect(outcome.status === 'skipped' && outcome.detail?.note).toContain('MONETIZATION_PROVIDER');
  });

  it('records revenue and reports done with the figures', async () => {
    const executor = new ParkingStepExecutor(
      new RevenueIngestionService({
        provider: fakeProvider([record('2026-10-01', 1.25), record('2026-10-02', 0.75)]),
        repo: fakeRepo({ lastDate: '2026-10-01' }),
      }),
    );

    const outcome = await executor.execute(ctx);

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' && outcome.detail).toEqual({
      provider: 'fake',
      recorded: 2,
      totalEur: 2.0,
      last30DaysEur: 2.0,
      since: '2026-10-01',
    });
  });

  it('fails visibly when the provider throws', async () => {
    const provider = fakeProvider([]);
    provider.fetchRevenue = vi.fn(async () => {
      throw new Error('revenue endpoint unreachable');
    });
    const executor = new ParkingStepExecutor(
      new RevenueIngestionService({ provider, repo: fakeRepo() }),
    );

    const outcome = await executor.execute(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toBe('revenue endpoint unreachable');
  });
});
