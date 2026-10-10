// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { PostgresAdapter } from '../../provider/postgres-adapter.js';
import type { DatabaseProvider } from '../../provider/interface.js';
import { SubscriptionRepository } from '../subscription-repository.js';
import { TeamSeatsRepository } from '../team-seats-repository.js';
import { UsageRepository } from '../usage-repository.js';
import { ProviderCacheRepository } from '../provider-cache-repository.js';
import { MetricsRepository } from '../metrics-repository.js';
import { PublicScoreRepository } from '../public-score-repository.js';
import { PortfolioRepository } from '../portfolio-repository.js';
import { PipelineRunsRepository } from '../pipeline-runs-repository.js';
import { CandidateRepository } from '../candidate-repository.js';
import { TldCostRepository } from '../tld-cost-repository.js';
import { TeamInvitationsRepository } from '../team-invitations-repository.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import { runWithTenant } from '../../../utils/tenant-context.js';

/**
 * The same assertions run against SQLite (always) and PostgreSQL (when
 * DATABASE_URL points at a migrated database — the `test-pg` CI job). They pin
 * the SQL that used to be SQLite-only: `datetime('now')`, `INSERT OR REPLACE`,
 * and INSERTs into tables with no `id` column.
 */
interface Dialect {
  name: string;
  open: () => Promise<DatabaseProvider>;
}

const PG_URL = process.env.DATABASE_URL ?? '';

const dialects: Dialect[] = [
  {
    name: 'sqlite',
    open: async (): Promise<DatabaseProvider> => {
      const db = SqliteProvider.openInMemory();
      await db.runMigrations();
      return db;
    },
  },
  ...(PG_URL ? [{ name: 'postgres', open: () => PostgresAdapter.create(PG_URL) }] : []),
];

// Unique per run so a shared, long-lived PG database never collides.
const RUN = randomBytes(4).toString('hex');
const tenant = (label: string): string => `${label}-${RUN}`;

describe.each(dialects)('repository SQL parity ($name)', ({ open }) => {
  let db: DatabaseProvider;

  beforeAll(async () => {
    db = await open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('subscriptions: upsert, status change and cancel stamp updated_at', async () => {
    const repo = new SubscriptionRepository(db);
    const t = tenant('sub');
    await repo.upsert({ tenantId: t, plan: 'pro', status: 'active' });
    await repo.upsert({ tenantId: t, plan: 'team', status: 'active' });
    await repo.updateStatus(t, 'past_due');
    expect((await repo.findByTenantId(t))?.plan).toBe('team');
    expect((await repo.findByTenantId(t))?.status).toBe('past_due');
    await repo.cancel(t, new Date().toISOString());
    expect((await repo.findByTenantId(t))?.status).toBe('canceled');
  });

  it('team seats: invite, re-invite, accept, count occupied vs active', async () => {
    const repo = new TeamSeatsRepository(db);
    const t = tenant('seats');
    await repo.invite(t, 'u1', 'member', 'owner');
    await repo.invite(t, 'u1', 'admin', 'owner');
    await repo.invite(t, 'u2', 'member', 'owner');
    expect(await repo.countOccupiedSeats(t)).toBe(2);
    await repo.acceptInvite(t, 'u1');
    expect(await repo.countActiveSeats(t)).toBe(1);
    expect(await repo.countOccupiedSeats(t)).toBe(2);
  });

  it('usage: increments accumulate across upserts', async () => {
    const repo = new UsageRepository(db);
    const t = tenant('usage');
    await repo.incrementUsage(t, 'api_calls', 2, '2026-01-01');
    await repo.incrementUsage(t, 'api_calls', 3, '2026-01-01');
    expect((await repo.getUsage(t, 'api_calls', '2026-01-01'))?.amount).toBe(5);
  });

  it('provider cache: set overwrites, expired entries are pruned', async () => {
    const repo = new ProviderCacheRepository(db);
    const key = `k-${RUN}`;
    await repo.set(key, 'p', 'one', 1);
    await repo.set(key, 'p', 'two', 1);
    expect(await repo.get(key, 'p')).toBe('two');
    await repo.set(`old-${RUN}`, 'p', 'x', -1);
    expect(await repo.pruneExpired()).toBeGreaterThanOrEqual(1);
    expect(await repo.get(`old-${RUN}`, 'p')).toBeNull();
  });

  it('pipeline metrics: re-inserting a stage replaces it', async () => {
    const runs = new PipelineRunsRepository(db);
    const metrics = new MetricsRepository(db);
    const runId = `run-${RUN}`;
    await runWithTenant(tenant('metrics'), () =>
      runs.insert({
        runId,
        startedAt: new Date().toISOString(),
        hostVersion: 't',
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    await metrics.insertBatch(runId, [
      { stageName: 'scoring', passed: 1, filtered: 0, durationMs: 5, error: false },
    ]);
    await metrics.insertBatch(runId, [
      { stageName: 'scoring', passed: 9, filtered: 1, durationMs: 7, error: false },
    ]);
    const stages = await metrics.findByRunId(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.passed).toBe(9);
  });

  it('public scores: recent listing honours the day window', async () => {
    const repo = new PublicScoreRepository(db);
    await repo.insert(`slug-${RUN}`, `parity-${RUN}.com`, '{}', null);
    const recent = await repo.listRecentScores(7, 1000);
    expect(recent.map((r) => r.slug)).toContain(`slug-${RUN}`);
    // A window ending tomorrow (negative days) must exclude it; avoids racing the DB clock.
    expect(await repo.listRecentScores(-1, 1000)).not.toContainEqual(
      expect.objectContaining({ slug: `slug-${RUN}` }),
    );
  });

  it('portfolio: expiring-soon honours renewal window and verification age', async () => {
    const repo = new PortfolioRepository(db);
    const t = tenant('portfolio');
    await runWithTenant(t, async () => {
      await repo.insert({
        domain: `soon-${RUN}.com`,
        tld: '.com',
        acquiredAt: new Date().toISOString(),
        renewalDate: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        acquisitionCost: 10,
        renewalCost: 12,
        registrar: 'x',
      });
      await repo.insert({
        domain: `later-${RUN}.com`,
        tld: '.com',
        acquiredAt: new Date().toISOString(),
        renewalDate: new Date(Date.now() + 200 * 86_400_000).toISOString(),
        acquisitionCost: 10,
        renewalCost: 12,
        registrar: 'x',
      });
      const due = await repo.getExpiringInDays(30);
      expect(due.map((d) => d.domain)).toEqual([`soon-${RUN}.com`]);

      await repo.updateVerificationTimestamp(`soon-${RUN}.com`);
      expect(await repo.getExpiringInDays(30)).toHaveLength(0);
    });
  });

  it('tld costs: upsert updates in place', async () => {
    const repo = new TldCostRepository(db);
    await repo.upsert(`p${RUN}`, 10, 'a');
    await repo.upsert(`p${RUN}`, 12, 'b');
    expect((await repo.findByTld(`p${RUN}`))?.renewalCostEur).toBe(12);
  });

  it('candidates: the same domain can live in two tenants', async () => {
    const repo = new CandidateRepository(db);
    const domain = `shared-${RUN}.com`;
    const base = {
      domain,
      tld: '.com',
      source: CandidateSource.CloseoutCsv,
      isPremium: false,
      pipelineRunId: 'r',
    };
    await runWithTenant(tenant('ca'), () =>
      repo.upsert({ ...base, status: CandidateStatus.Scored }),
    );
    await runWithTenant(tenant('cb'), () =>
      repo.upsert({ ...base, status: CandidateStatus.TrademarkBlocked }),
    );
    const a = await runWithTenant(tenant('ca'), () => repo.findByDomain(domain));
    const b = await runWithTenant(tenant('cb'), () => repo.findByDomain(domain));
    expect(a?.status).toBe(CandidateStatus.Scored);
    expect(b?.status).toBe(CandidateStatus.TrademarkBlocked);
  });

  it('team invitations: create, list pending, single-use claim, revoke', async () => {
    const repo = new TeamInvitationsRepository(db);
    const t = tenant('inv');
    const soon = new Date(Date.now() + 3_600_000);
    const a = await repo.create({
      tenantId: t,
      email: 'a@example.com',
      role: 'member',
      tokenHash: `h1-${RUN}`,
      invitedBy: 'owner',
      expiresAt: soon,
    });
    const b = await repo.create({
      tenantId: t,
      email: 'b@example.com',
      role: 'admin',
      tokenHash: `h2-${RUN}`,
      invitedBy: 'owner',
      expiresAt: soon,
    });
    await repo.create({
      tenantId: t,
      email: 'old@example.com',
      role: 'member',
      tokenHash: `h3-${RUN}`,
      invitedBy: 'owner',
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await repo.countPending(t)).toBe(2);
    expect((await repo.listPending(t)).map((i) => i.email).sort()).toEqual([
      'a@example.com',
      'b@example.com',
    ]);

    expect(await repo.claim(a.id, 'u1')).toBe(true);
    expect(await repo.claim(a.id, 'u2')).toBe(false); // single use
    expect(await repo.countPending(t)).toBe(1);
    expect((await repo.findByTokenHash(`h1-${RUN}`))?.acceptedAt).not.toBeNull();
    expect(
      new Date((await repo.findByTokenHash(`h2-${RUN}`))!.expiresAt).getTime(),
    ).toBeGreaterThan(Date.now());

    expect(await repo.revoke('someone-else', b.id)).toBe(false);
    expect(await repo.revoke(t, b.id)).toBe(true);
    expect(await repo.countPending(t)).toBe(0);
  });

  it('inserts into tables without an id column succeed (auth_rate_limits)', async () => {
    const res = await db.exec(
      `INSERT INTO auth_rate_limits (ip, failures, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET failures = 1`,
      [`10.${RUN}`, new Date().toISOString()],
    );
    expect(res.changes).toBe(1);
  });
});
