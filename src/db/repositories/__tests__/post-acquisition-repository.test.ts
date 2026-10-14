// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { PostAcquisitionRepository } from '../post-acquisition-repository.js';
import { AutomationAuditRepository } from '../automation-audit-repository.js';

function createTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.exec(`
    CREATE TABLE IF NOT EXISTS post_acquisition_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      step TEXT NOT NULL CHECK(step IN ('portfolio','site','indexing','dns','parking','listing')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','done','skipped','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'purchase',
      pipeline_run_id TEXT,
      detail_json TEXT,
      last_error TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(domain, step, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_acq_domain_status ON post_acquisition_steps(domain, status);
    CREATE TABLE IF NOT EXISTS automation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      domain TEXT,
      actor TEXT NOT NULL DEFAULT 'system',
      detail_json TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_automation_audit_created_at ON automation_audit(created_at);
  `);
  return provider;
}

describe('PostAcquisitionRepository', () => {
  let provider: SqliteProvider;
  let repo: PostAcquisitionRepository;

  beforeEach(() => {
    provider = createTestDb();
    repo = new PostAcquisitionRepository(provider);
  });

  it('upsert is idempotent per domain+step', async () => {
    const first = await repo.upsert({ domain: 'example.com', step: 'listing', source: 'purchase' });
    const second = await repo.upsert({
      domain: 'example.com',
      step: 'listing',
      source: 'purchase',
    });
    expect(first.id).toBe(second.id);
  });

  it('tracks attempts and terminal states', async () => {
    const row = await repo.upsert({ domain: 'example.com', step: 'listing', source: 'purchase' });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);

    await repo.incrementAttempts(row.id);
    await repo.markDone(row.id, { listingId: 42 });

    const after = await repo.findByDomainAndStep('example.com', 'listing');
    expect(after?.status).toBe('done');
    expect(after?.attempts).toBe(1);
    expect(after?.detailJson).toBe(JSON.stringify({ listingId: 42 }));
    expect(after?.lastError).toBeNull();
  });

  it('marks skipped and failed with the reason', async () => {
    const row = await repo.upsert({ domain: 'skip.com', step: 'dns', source: 'manual' });
    await repo.markSkipped(row.id, 'dry_run');
    let found = await repo.findByDomainAndStep('skip.com', 'dns');
    expect(found?.status).toBe('skipped');
    expect(found?.lastError).toBe('dry_run');

    const row2 = await repo.upsert({ domain: 'fail.com', step: 'parking', source: 'purchase' });
    await repo.markFailed(row2.id, 'provider down');
    found = await repo.findByDomainAndStep('fail.com', 'parking');
    expect(found?.status).toBe('failed');
    expect(found?.lastError).toBe('provider down');
  });

  it('resets a step or a whole domain to pending', async () => {
    const a = await repo.upsert({ domain: 'reset.com', step: 'listing', source: 'purchase' });
    await repo.upsert({ domain: 'reset.com', step: 'dns', source: 'purchase' });
    await repo.markDone(a.id);

    await repo.resetStep('reset.com', 'listing');
    expect((await repo.findByDomainAndStep('reset.com', 'listing'))?.status).toBe('pending');

    await repo.markDone((await repo.findByDomainAndStep('reset.com', 'dns'))!.id);
    await repo.resetDomain('reset.com');
    const rows = await repo.findByDomain('reset.com');
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('lists steps by status and recency', async () => {
    await repo.upsert({ domain: 'a.com', step: 'listing', source: 'purchase' });
    const b = await repo.upsert({ domain: 'b.com', step: 'listing', source: 'purchase' });
    await repo.markDone(b.id);

    const done = await repo.listRecent({ status: 'done' });
    expect(done.map((r) => r.domain)).toEqual(['b.com']);

    const all = await repo.listRecent();
    expect(all.length).toBe(2);
    expect(all[0]?.domain).toBe('b.com'); // most recently updated first
  });
});

describe('AutomationAuditRepository', () => {
  let provider: SqliteProvider;
  let repo: AutomationAuditRepository;

  beforeEach(() => {
    provider = createTestDb();
    repo = new AutomationAuditRepository(provider);
  });

  it('stores and lists audit entries with parsed detail', async () => {
    await repo.insert({ action: 'automation_disabled', domain: 'x.com', actor: 'purchase' });
    await repo.insert({
      action: 'step_listing_done',
      domain: 'x.com',
      actor: 'purchase',
      detail: { listingId: 7 },
    });

    const entries = await repo.listRecent(10);
    expect(entries.length).toBe(2);
    expect(entries[0]?.action).toBe('step_listing_done'); // newest first
    expect(entries[0]?.detailJson).toBe(JSON.stringify({ listingId: 7 }));

    const forDomain = await repo.findByDomain('x.com');
    expect(forDomain.length).toBe(2);
  });
});
