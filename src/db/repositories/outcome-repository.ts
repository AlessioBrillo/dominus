import type { DatabaseProvider } from '../provider/interface.js';
import type { Outcome, RecordOutcomeInput, OutcomeType } from '../../types/outcome.js';
import { isOutcomeType } from '../../types/outcome.js';
import { DomainNotFoundError } from '../../types/errors.js';

interface OutcomeRow {
  id: number;
  domain: string;
  type: string;
  occurred_at: string;
  sale_price_eur: number | null;
  listing_price_eur: number | null;
  days_listed: number | null;
  venue: string | null;
  commission_pct: number | null;
  acquisition_cost_eur: number | null;
  total_renewal_cost_eur: number | null;
  notes: string | null;
  created_at: string;
}

function rowToOutcome(row: OutcomeRow): Outcome {
  const type: OutcomeType = isOutcomeType(row.type) ? row.type : 'renewed';
  return {
    id: row.id,
    domain: row.domain,
    type,
    occurredAt: row.occurred_at,
    salePriceEur: row.sale_price_eur ?? undefined,
    listingPriceEur: row.listing_price_eur ?? undefined,
    daysListed: row.days_listed ?? undefined,
    venue: row.venue ?? undefined,
    commissionPct: row.commission_pct ?? undefined,
    acquisitionCostEur: row.acquisition_cost_eur ?? undefined,
    totalRenewalCostEur: row.total_renewal_cost_eur ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * CRUD over the `outcomes` table. Outcomes are append-only at the
 * application level: there is no `update` method. If the operator
 * records a wrong event, the correction is itself a new outcome
 * (typically of type `renewed` to undo a premature `dropped`, or a
 * follow-up `sold` that supersedes a `renewed`).
 *
 * The FK to `portfolio_entries(domain)` with `ON DELETE CASCADE`
 * guarantees that removing a portfolio entry also removes its
 * outcomes — keeping the data model honest.
 */
export class OutcomeRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Insert a new outcome. Throws if `domain` is not in the portfolio. */
  async insert(input: RecordOutcomeInput): Promise<Outcome> {
    const exists = await this.db.queryOne<{ 1: number }>(
      'SELECT 1 FROM portfolio_entries WHERE domain = ?',
      [input.domain],
    );
    if (exists === null) {
      throw new DomainNotFoundError(input.domain);
    }

    try {
      const row = await this.db.queryOne<{ id: number }>(
        `INSERT INTO outcomes
           (domain, type, occurred_at, sale_price_eur, listing_price_eur,
            days_listed, venue, commission_pct,
            acquisition_cost_eur, total_renewal_cost_eur, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
        [
          input.domain,
          input.type,
          input.occurredAt,
          input.salePriceEur ?? null,
          input.listingPriceEur ?? null,
          input.daysListed ?? null,
          input.venue ?? null,
          input.commissionPct ?? null,
          input.acquisitionCostEur ?? null,
          input.totalRenewalCostEur ?? null,
          input.notes ?? null,
        ],
      )!;
      const inserted = (
        await this.db.queryOne<OutcomeRow>('SELECT * FROM outcomes WHERE id = ?', [row.id])
      )!;
      return rowToOutcome(inserted);
    } catch (err: unknown) {
      // SQLite FK violation as safety net — should not trigger since we
      // already checked, but kept as defence-in-depth.
      const message = err instanceof Error ? err.message : String(err);
      if (/FOREIGN KEY/i.test(message) || /constraint failed/i.test(message)) {
        throw new DomainNotFoundError(input.domain);
      }
      throw err;
    }
  }

  async findById(id: number): Promise<Outcome | null> {
    const row = await this.db.queryOne<OutcomeRow>('SELECT * FROM outcomes WHERE id = ?', [id]);
    return row ? rowToOutcome(row) : null;
  }

  /** All outcomes for one portfolio domain, most recent first. */
  async findByDomain(domain: string): Promise<Outcome[]> {
    const rows = await this.db.query<OutcomeRow>(
      'SELECT * FROM outcomes WHERE domain = ? ORDER BY occurred_at DESC, id DESC',
      [domain],
    );
    return rows.map(rowToOutcome);
  }

  /** All outcomes in the database, most recent first. */
  async findAll(): Promise<Outcome[]> {
    const rows = await this.db.query<OutcomeRow>(
      'SELECT * FROM outcomes ORDER BY occurred_at DESC, id DESC',
    );
    return rows.map(rowToOutcome);
  }

  /** Outcomes of a specific type, most recent first. */
  async findByType(type: OutcomeType): Promise<Outcome[]> {
    const rows = await this.db.query<OutcomeRow>(
      'SELECT * FROM outcomes WHERE type = ? ORDER BY occurred_at DESC, id DESC',
      [type],
    );
    return rows.map(rowToOutcome);
  }

  /** Aggregate stats for a single portfolio domain. */
  async statsByDomain(domain: string): Promise<{
    sold: number;
    dropped: number;
    expired: number;
    renewed: number;
    totalRealisedEur: number;
  }> {
    const row = (
      await this.db.queryOne<{
        sold: number | null;
        dropped: number | null;
        expired: number | null;
        renewed: number | null;
        total_realised_eur: number | null;
      }>(
        `SELECT
           SUM(CASE WHEN type = 'sold'    THEN 1 ELSE 0 END) AS sold,
           SUM(CASE WHEN type = 'dropped' THEN 1 ELSE 0 END) AS dropped,
           SUM(CASE WHEN type = 'expired' THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN type = 'renewed' THEN 1 ELSE 0 END) AS renewed,
           COALESCE(SUM(CASE WHEN type = 'sold' THEN sale_price_eur ELSE 0 END), 0) AS total_realised_eur
         FROM outcomes WHERE domain = ?`,
        [domain],
      )
    )!;
    return {
      sold: row.sold ?? 0,
      dropped: row.dropped ?? 0,
      expired: row.expired ?? 0,
      renewed: row.renewed ?? 0,
      totalRealisedEur: row.total_realised_eur ?? 0,
    };
  }

  /** Hard delete an outcome. Used by tests; the CLI does not expose this. */
  async delete(id: number): Promise<void> {
    await this.db.exec('DELETE FROM outcomes WHERE id = ?', [id]);
  }
}
