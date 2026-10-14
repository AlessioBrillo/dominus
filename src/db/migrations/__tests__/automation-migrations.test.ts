// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { PostAcquisitionRepository } from '../../repositories/post-acquisition-repository.js';
import { DomainSiteRepository } from '../../repositories/domain-site-repository.js';
import { getMigrations } from '../registry.js';

/**
 * Runs the two automation migrations (0061, 0062) against a real in-memory
 * SQLite database and exercises the repositories on the resulting schema.
 * Guards the migration SQL itself — including the ON CONFLICT targets the
 * repositories rely on.
 */
describe('Automation migrations (0061 + 0062)', () => {
  it('create the automation tables and support the repository contracts', async () => {
    const db = new Database(':memory:');
    const migrations = getMigrations().filter((m) =>
      ['0061_create_automation_tables', '0062_create_domain_sites'].includes(m.name),
    );
    expect(migrations.map((m) => m.name)).toEqual([
      '0061_create_automation_tables',
      '0062_create_domain_sites',
    ]);

    for (const migration of migrations) {
      migration.up(db);
    }

    const provider = new SqliteProvider(db);
    const steps = new PostAcquisitionRepository(provider);
    const sites = new DomainSiteRepository(provider);

    const first = await steps.upsert({
      domain: 'vintagecoffee.com',
      step: 'site',
      source: 'purchase',
    });
    const second = await steps.upsert({
      domain: 'vintagecoffee.com',
      step: 'site',
      source: 'purchase',
    });
    expect(second.id).toBe(first.id);
    await steps.incrementAttempts(first.id);
    await steps.markDone(first.id, { url: '/public/for-sale/vintagecoffee.com' });
    expect((await steps.findByDomainAndStep('vintagecoffee.com', 'site'))?.status).toBe('done');

    await sites.upsert({
      domain: 'vintagecoffee.com',
      headline: 'vintagecoffee.com is for sale',
      summary: 'summary',
      askingPriceEur: 1200,
      scoreJson: '{"expectedValue":400}',
      contact: null,
    });
    await sites.upsert({
      domain: 'vintagecoffee.com',
      headline: 'vintagecoffee.com is for sale',
      summary: 'summary',
      askingPriceEur: 1500,
      scoreJson: '{"expectedValue":400}',
      contact: null,
    });

    const page = await sites.findByDomainPublic('vintagecoffee.com');
    expect(page?.askingPriceEur).toBe(1500);
    expect(await sites.listForSitemap()).toHaveLength(1);
  });
});
