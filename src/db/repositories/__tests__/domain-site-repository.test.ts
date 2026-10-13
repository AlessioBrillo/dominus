// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { DomainSiteRepository } from '../domain-site-repository.js';

function createTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.exec(`
    CREATE TABLE IF NOT EXISTS domain_sites (
      domain TEXT PRIMARY KEY,
      headline TEXT NOT NULL,
      summary TEXT NOT NULL,
      asking_price_eur REAL,
      score_json TEXT NOT NULL,
      contact TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
});
