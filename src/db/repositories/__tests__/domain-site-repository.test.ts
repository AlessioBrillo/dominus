// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { DomainSiteRepository } from '../domain-site-repository.js';
import { runWithTenant } from '../../../utils/tenant-context.js';

function createTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.exec(`
    CREATE TABLE IF NOT EXISTS domain_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      headline TEXT NOT NULL,
      summary TEXT NOT NULL,
      asking_price_eur REAL,
      score_json TEXT NOT NULL,
      contact TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      ownership_verified_at TEXT,
      ownership_token TEXT,
      UNIQUE(domain, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_sites_published_at ON domain_sites(published_at);
  `);
  return provider;
}

describe('DomainSiteRepository', () => {
  let provider: SqliteProvider;
  let repo: DomainSiteRepository;

  beforeEach(() => {
    provider = createTestDb();
    repo = new DomainSiteRepository(provider);
  });

  const site = {
    domain: 'vintagecoffee.com',
    headline: 'vintagecoffee.com is for sale',
    summary: 'summary text',
    askingPriceEur: 1200,
    scoreJson: '{"expectedValue":400}',
    contact: 'owner@example.com',
  };

  it('upserts idempotently per domain', async () => {
    await repo.upsert(site);
    await repo.upsert({ ...site, askingPriceEur: 1500 });

    const found = await repo.findByDomainPublic('vintagecoffee.com');
    expect(found?.askingPriceEur).toBe(1500);
    expect(found?.headline).toBe(site.headline);
    expect(found?.contact).toBe('owner@example.com');
  });

  it('reads published pages without a tenant filter (public surface)', async () => {
    await repo.upsert(site);
    const found = await repo.findByDomainPublic('vintagecoffee.com');
    expect(found).not.toBeNull();
    expect(found?.publishedAt).toBeTruthy();
  });

  it('returns null for unpublished domains', async () => {
    expect(await repo.findByDomainPublic('other.com')).toBeNull();
  });

  it('lists pages for the sitemap', async () => {
    await repo.upsert(site);
    await repo.upsert({ ...site, domain: 'second.com' });
    const rows = await repo.listForSitemap();
    expect(rows.length).toBe(2);
  });

  it('deletes a page', async () => {
    await repo.upsert(site);
    await repo.delete('vintagecoffee.com');
    expect(await repo.findByDomainPublic('vintagecoffee.com')).toBeNull();
  });

  it('keeps one row per (domain, tenant): two tenants can track the same domain', async () => {
    await runWithTenant('tenant-a', () => repo.upsert({ ...site, askingPriceEur: 1000 }));
    await runWithTenant('tenant-b', () => repo.upsert({ ...site, askingPriceEur: 2000 }));

    // Re-publishing within the same tenant updates the row (no duplicate).
    await runWithTenant('tenant-a', () => repo.upsert({ ...site, askingPriceEur: 1500 }));

    const rowsForTenantA = await runWithTenant('tenant-a', () =>
      provider.query<{ asking_price_eur: number }>(
        'SELECT asking_price_eur FROM domain_sites WHERE tenant_id = ?',
        ['tenant-a'],
      ),
    );
    expect(rowsForTenantA).toHaveLength(1);
    expect(rowsForTenantA[0]?.asking_price_eur).toBe(1500);

    // The public surface still exposes exactly one page per domain name.
    expect(await repo.listForSitemap()).toHaveLength(1);
  });

  it('marks ownership verified only for the matching DNS token', async () => {
    await runWithTenant('tenant-a', () =>
      repo.upsert({
        domain: 'vintagecoffee.com',
        headline: 'For sale',
        summary: 'A domain',
        askingPriceEur: 1000,
        scoreJson: '{}',
        contact: null,
      }),
    );
    await repo.setOwnershipToken('vintagecoffee.com', 'expected-hash');
    expect(await repo.ownershipTokenHash('vintagecoffee.com')).toBe('expected-hash');
    expect(await repo.confirmOwnership('vintagecoffee.com', 'wrong-hash')).toBe(false);
    expect(await repo.confirmOwnership('vintagecoffee.com', 'expected-hash')).toBe(true);
    expect(
      (await repo.findByDomainPublic('vintagecoffee.com'))?.ownershipVerifiedAt,
    ).not.toBeNull();
    expect(await repo.ownershipTokenHash('vintagecoffee.com')).toBeNull();
  });

  it("does not let a token request downgrade another tenant's verified page", async () => {
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await runWithTenant(tenant, () =>
        repo.upsert({
          domain: 'shared.com',
          headline: 'For sale',
          summary: 'A domain',
          askingPriceEur: 1000,
          scoreJson: '{}',
          contact: null,
        }),
      );
    }
    await repo.setOwnershipToken('shared.com', 'hash-a');
    expect(await repo.confirmOwnership('shared.com', 'hash-a')).toBe(true);

    await repo.setOwnershipToken('shared.com', 'hash-b');
    expect(await repo.ownershipTokenHash('shared.com')).toBeNull();
    expect((await repo.findByDomainPublic('shared.com'))?.ownershipVerifiedAt).not.toBeNull();
  });
});
