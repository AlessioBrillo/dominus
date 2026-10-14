// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type { DomainSite, DomainSiteRow, NewDomainSite } from '../../types/domain-site.js';
import { domainSiteFromRow } from '../../types/domain-site.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

const COLUMNS =
  'domain, headline, summary, asking_price_eur, score_json, contact, published_at, updated_at';

/**
 * Repository of published for-sale pages (ADR-0083, M2).
 *
 * Writes are tenant-scoped; public reads are not — a published page is
 * content the operator deliberately made public, exactly like
 * public_scores (ADR-0030).
 */
export class DomainSiteRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async upsert(site: NewDomainSite): Promise<void> {
    await this.db.exec(
      `INSERT INTO domain_sites (domain, headline, summary, asking_price_eur, score_json, contact, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (domain, tenant_id) DO UPDATE SET
         headline = excluded.headline,
         summary = excluded.summary,
         asking_price_eur = excluded.asking_price_eur,
         score_json = excluded.score_json,
         contact = excluded.contact,
         updated_at = CURRENT_TIMESTAMP`,
      [
        site.domain,
        site.headline,
        site.summary,
        site.askingPriceEur,
        site.scoreJson,
        site.contact,
        resolveTenantId(),
      ],
    );
  }

  /** Public read: no tenant filter (a published page is public content).
   *  Deterministic: the most recently updated page wins when more than one
   *  tenant published a page for the same domain. */
  async findByDomainPublic(domain: string): Promise<DomainSite | null> {
    const row = await this.db.queryOne<DomainSiteRow>(
      `SELECT ${COLUMNS} FROM domain_sites WHERE domain = ? ORDER BY updated_at DESC LIMIT 1`,
      [domain],
    );
    return row ? domainSiteFromRow(row) : null;
  }

  async listForSitemap(limit: number = 1000): Promise<DomainSite[]> {
    const rows = await this.db.query<DomainSiteRow>(
      `SELECT ${COLUMNS} FROM domain_sites ORDER BY published_at DESC LIMIT ?`,
      [limit],
    );
    // One sitemap entry per domain: two tenants can track the same domain
    // (unique is per tenant), but the public site has one page per name.
    const seen = new Set<string>();
    const unique: DomainSite[] = [];
    for (const site of rows.map(domainSiteFromRow)) {
      if (seen.has(site.domain)) continue;
      seen.add(site.domain);
      unique.push(site);
    }
    return unique;
  }

  async delete(domain: string): Promise<void> {
    await this.db.exec('DELETE FROM domain_sites WHERE domain = ? AND tenant_id = ?', [
      domain,
      resolveTenantId(),
    ]);
  }
}
