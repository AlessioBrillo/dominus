// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type { DomainRevenueSummary, RevenueRecord, RevenueRow } from '../../types/monetization.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

/**
 * Ad-revenue records (ADR-0083, M3).
 *
 * `record` is the idempotent ingestion entry point: the same
 * (domain, date, source) always updates the same row, so a re-run of the
 * parking step or a repeated scheduled ingestion never double-counts.
 * Every query filters on the resolved tenant id.
 */
export class MonetizationRevenueRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Insert-or-update one revenue record. Returns the stored row id. */
  async record(record: RevenueRecord): Promise<number> {
    const existing = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM monetization_revenue
        WHERE domain = ? AND revenue_date = ? AND source = ? AND tenant_id = ?`,
      [record.domain, record.date, record.source, resolveTenantId()],
    );

    if (existing) {
      await this.db.exec(
        `UPDATE monetization_revenue
           SET amount_eur = ?, fetched_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [record.amountEur, record.fetchedAt, existing.id, resolveTenantId()],
      );
      return existing.id;
    }

    await this.db.exec(
      `INSERT INTO monetization_revenue (domain, revenue_date, amount_eur, source, fetched_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.domain,
        record.date,
        record.amountEur,
        record.source,
        record.fetchedAt,
        resolveTenantId(),
      ],
    );

    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM monetization_revenue
        WHERE domain = ? AND revenue_date = ? AND source = ? AND tenant_id = ?`,
      [record.domain, record.date, record.source, resolveTenantId()],
    );
    if (!row) {
      throw new Error(`monetization_revenue row for ${record.domain}/${record.date} not found`);
    }
    return row.id;
  }

  /** Record many revenue rows in one call (each one idempotent). */
  async recordAll(records: readonly RevenueRecord[]): Promise<number> {
    let recorded = 0;
    for (const record of records) {
      await this.record(record);
      recorded += 1;
    }
    return recorded;
  }

  async findByDomain(domain: string, limit = 90): Promise<RevenueRow[]> {
    return this.db.query<RevenueRow>(
      `SELECT id, domain, revenue_date, amount_eur, source, fetched_at, tenant_id
        FROM monetization_revenue
       WHERE domain = ? AND tenant_id = ?
       ORDER BY revenue_date DESC LIMIT ?`,
      [domain, resolveTenantId(), limit],
    );
  }

  /** Total revenue recorded for a domain, optionally since an ISO date. */
  async totalSince(domain: string, since?: string): Promise<number> {
    const row = since
      ? await this.db.queryOne<{ total: number | null }>(
          `SELECT SUM(amount_eur) AS total FROM monetization_revenue
            WHERE domain = ? AND tenant_id = ? AND revenue_date >= ?`,
          [domain, resolveTenantId(), since],
        )
      : await this.db.queryOne<{ total: number | null }>(
          `SELECT SUM(amount_eur) AS total FROM monetization_revenue
            WHERE domain = ? AND tenant_id = ?`,
          [domain, resolveTenantId()],
        );
    return row?.total ?? 0;
  }

  /** Most recent revenue date recorded for a domain, or null. */
  async lastRecordDate(domain: string): Promise<string | null> {
    const row = await this.db.queryOne<{ revenue_date: string }>(
      `SELECT revenue_date FROM monetization_revenue
        WHERE domain = ? AND tenant_id = ?
       ORDER BY revenue_date DESC LIMIT 1`,
      [domain, resolveTenantId()],
    );
    return row?.revenue_date ?? null;
  }

  /** Oldest revenue date recorded for a domain, or null when none. */
  async firstRecordDate(domain: string): Promise<string | null> {
    const row = await this.db.queryOne<{ revenue_date: string }>(
      `SELECT revenue_date FROM monetization_revenue
        WHERE domain = ? AND tenant_id = ?
       ORDER BY revenue_date ASC LIMIT 1`,
      [domain, resolveTenantId()],
    );
    return row?.revenue_date ?? null;
  }

  /** Summary for one domain: total, last 30 days, most recent record. */
  async summarize(domain: string, now: Date = new Date()): Promise<DomainRevenueSummary> {
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = await this.findByDomain(domain);
    const last30DaysEur = rows
      .filter((r) => r.revenue_date >= since30)
      .reduce((sum, r) => sum + r.amount_eur, 0);

    return {
      domain,
      totalEur: rows.reduce((sum, r) => sum + r.amount_eur, 0),
      last30DaysEur,
      lastRecordDate: rows.length > 0 ? rows[0]!.revenue_date : null,
      records: rows.length,
    };
  }
}
