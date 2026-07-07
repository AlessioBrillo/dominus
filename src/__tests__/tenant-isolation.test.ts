import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrator.js';
import { SqliteProvider } from '../db/provider/sqlite-adapter.js';
import { CandidateRepository } from '../db/repositories/candidate-repository.js';
import { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { DomainCandidate } from '../types/candidate.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import { runWithTenant, getTenantId, resolveTenantId } from '../utils/tenant-context.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

const makeCandidate = (
  domain: string,
  overrides: Partial<DomainCandidate> = {},
): DomainCandidate => ({
  domain,
  tld: '.com',
  source: CandidateSource.CloseoutCsv,
  status: CandidateStatus.Pending,
  isPremium: false,
  pipelineRunId: 'run-001',
  ...overrides,
});

describe('tenant isolation (SQLite)', () => {
  let provider: SqliteProvider;
  let repo: CandidateRepository;

  beforeEach(() => {
    provider = openTestDb();
    repo = new CandidateRepository(provider);
  });

  it('resolveTenantId() returns "default" outside runWithTenant scope', () => {
    expect(resolveTenantId()).toBe('default');
  });

  it('getTenantId() returns undefined outside runWithTenant scope', () => {
    expect(getTenantId()).toBeUndefined();
  });

  it('runWithTenant sets the tenant context for the callback scope', () => {
    runWithTenant('tenant-a', () => {
      expect(getTenantId()).toBe('tenant-a');
      expect(resolveTenantId()).toBe('tenant-a');
    });
  });

  it('tenant context is isolated between nested scopes', () => {
    runWithTenant('outer', () => {
      expect(getTenantId()).toBe('outer');
      runWithTenant('inner', () => {
        expect(getTenantId()).toBe('inner');
      });
      expect(getTenantId()).toBe('outer');
    });
  });

  it('insert and query scope data per tenant', async () => {
    await runWithTenant('alice', async () => {
      await repo.insert(makeCandidate('alice.com'));
    });
    await runWithTenant('bob', async () => {
      await repo.insert(makeCandidate('bob.com'));
    });

    const aliceRows = await runWithTenant('alice', () => repo.findAll(100));
    const bobRows = await runWithTenant('bob', () => repo.findAll(100));
    const defaultRows = await repo.findAll(100);

    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]?.domain).toBe('alice.com');

    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]?.domain).toBe('bob.com');

    expect(defaultRows).toHaveLength(0);
  });

  it('findByDomain respects tenant isolation', async () => {
    await runWithTenant('tenant-x', () => repo.insert(makeCandidate('shared.com')));

    const inTenant = await runWithTenant('tenant-x', () => repo.findByDomain('shared.com'));
    expect(inTenant).not.toBeNull();

    const outside = await runWithTenant('tenant-y', () => repo.findByDomain('shared.com'));
    expect(outside).toBeNull();
  });

  it('updateStatus only affects the owning tenant rows', async () => {
    await runWithTenant('alice', () => repo.insert(makeCandidate('alice-only.com')));
    await runWithTenant('bob', () => repo.insert(makeCandidate('bob-only.com')));

    const aliceCandidate = await runWithTenant('alice', () => repo.findByDomain('alice-only.com'));
    expect(aliceCandidate).not.toBeNull();
    const aliceId = aliceCandidate!.id;
    expect(aliceId).toBeDefined();
    await runWithTenant('alice', () => repo.updateStatus(aliceId!, CandidateStatus.Scored));

    const bobCandidate = await runWithTenant('bob', () => repo.findByDomain('bob-only.com'));
    expect(bobCandidate).not.toBeNull();
    expect(bobCandidate!.status).toBe(CandidateStatus.Pending);
  });

  it('tenant isolation works across repository boundaries', async () => {
    const portfolioRepo = new PortfolioRepository(provider);

    await runWithTenant('tenant-z', async () => {
      await repo.insert(makeCandidate('mixed.io'));
      await portfolioRepo.insert({
        domain: 'mixed.io',
        tld: '.io',
        acquiredAt: new Date().toISOString(),
        renewalDate: new Date(Date.now() + 365 * 86400000).toISOString(),
        acquisitionCost: 10,
        renewalCost: 12,
        registrar: 'test',
      });
    });

    const candidateCount = await runWithTenant('tenant-z', () => repo.findAll(100));
    const portfolioCount = await runWithTenant('tenant-z', () => portfolioRepo.findAll());

    expect(candidateCount).toHaveLength(1);
    expect(portfolioCount).toHaveLength(1);
  });

  it('resolveTenantId returns explicit override', () => {
    expect(resolveTenantId('custom-override')).toBe('custom-override');
  });
});
