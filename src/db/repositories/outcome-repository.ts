import type Database from 'better-sqlite3';
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
  constructor(private readonly db: Database.Database) {}

  /** Insert a new outcome. Throws if `domain` is not in the portfolio. */
  insert(input: RecordOutcomeInput): Outcome {
    const stmt = this.db.prepare(
      `INSERT INTO outcomes
         (domain, type, occurred_at, sale_price_eur, listing_price_eur,
          days_listed, venue, commission_pct, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    );
    try {
      const row = stmt.get(
        input.domain,
        input.type,
        input.occurredAt,
        input.salePriceEur ?? null,
        input.listingPriceEur ?? null,
        input.daysListed ?? null,
        input.venue ?? null,
        input.commissionPct ?? null,
        input.notes ?? null,
      ) as { id: number };
      const inserted = this.db
        .prepare('SELECT * FROM outcomes WHERE id = ?')
        .get(row.id) as OutcomeRow;
      return rowToOutcome(inserted);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // SQLite FK violation surfaces as SQLITE_CONSTRAINT with the
      // index 'sqlite_autoindex_outcomes_1' or simply a FOREIGN KEY
      // constraint failed message.
      if (/FOREIGN KEY/i.test(message) || /constraint failed/i.test(message)) {
        throw new DomainNotFoundError(input.domain);
      }
      throw err;
    }
  }

  findById(id: number): Outcome | null {
    const row = this.db
      .prepare('SELECT * FROM outcomes WHERE id = ?')
      .get(id) as OutcomeRow | undefined;
    return row ? rowToOutcome(row) : null;
  }

  /** All outcomes for one portfolio domain, most recent first. */
  findByDomain(domain: string): Outcome[] {
    const rows = this.db
      .prepare('SELECT * FROM outcomes WHERE domain = ? ORDER BY occurred_at DESC, id DESC')
      .all(domain) as OutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** All outcomes in the database, most recent first. */
  findAll(): Outcome[] {
    const rows = this.db
      .prepare('SELECT * FROM outcomes ORDER BY occurred_at DESC, id DESC')
      .all() as OutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** Outcomes of a specific type, most recent first. */
  findByType(type: OutcomeType): Outcome[] {
    const rows = this.db
      .prepare('SELECT * FROM outcomes WHERE type = ? ORDER BY occurred_at DESC, id DESC')
      .all(type) as OutcomeRow[];
    return rows.map(rowToOutcome);
  }

  /** Aggregate stats for a single portfolio domain. */
  statsByDomain(domain: string): {
    sold: number;
    dropped: number;
    expired: number;
    renewed: number;
    totalRealisedEur: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN type = 'sold'    THEN 1 ELSE 0 END) AS sold,
           SUM(CASE WHEN type = 'dropped' THEN 1 ELSE 0 END) AS dropped,
           SUM(CASE WHEN type = 'expired' THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN type = 'renewed' THEN 1 ELSE 0 END) AS renewed,
           COALESCE(SUM(CASE WHEN type = 'sold' THEN sale_price_eur ELSE 0 END), 0) AS total_realised_eur
         FROM outcomes WHERE domain = ?`,
      )
      .get(domain) as {
        sold: number | null;
        dropped: number | null;
        expired: number | null;
        renewed: number | null;
        total_realised_eur: number | null;
      };
    return {
      sold: row.sold ?? 0,
      dropped: row.dropped ?? 0,
      expired: row.expired ?? 0,
      renewed: row.renewed ?? 0,
      totalRealisedEur: row.total_realised_eur ?? 0,
    };
  }

  /** Hard delete an outcome. Used by tests; the CLI does not expose this. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM outcomes WHERE id = ?').run(id);
  }
}
