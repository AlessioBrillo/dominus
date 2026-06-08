import type Database from 'better-sqlite3';
import type { PortfolioEntry, AddPortfolioEntryInput, Verdict } from '../../types/portfolio.js';
import { DuplicateDomainError, DomainNotFoundError } from '../../types/errors.js';

interface PortfolioRow {
  id: number;
  domain: string;
  tld: string;
  acquired_at: string;
  renewal_date: string;
  acquisition_cost: number;
  renewal_cost: number;
  registrar: string;
  current_score: number | null;
  suggested_list_price: number | null;
  verdict: string;
  verdict_reason: string | null;
  verdict_updated_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: PortfolioRow): PortfolioEntry {
  return {
    id: row.id,
    domain: row.domain,
    tld: row.tld,
    acquiredAt: row.acquired_at,
    renewalDate: row.renewal_date,
    acquisitionCost: row.acquisition_cost,
    renewalCost: row.renewal_cost,
    registrar: row.registrar,
    currentScore: row.current_score ?? undefined,
    suggestedListPrice: row.suggested_list_price ?? undefined,
    verdict: row.verdict as Verdict,
    verdictReason: row.verdict_reason ?? undefined,
    verdictUpdatedAt: row.verdict_updated_at ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PortfolioRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: AddPortfolioEntryInput): PortfolioEntry {
    const existing = this.findByDomain(input.domain);
    if (existing !== null) {
      throw new DuplicateDomainError(input.domain);
    }

    const stmt = this.db.prepare(
      `INSERT INTO portfolio_entries
       (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.domain,
      input.tld,
      input.acquiredAt,
      input.renewalDate,
      input.acquisitionCost,
      input.renewalCost,
      input.registrar,
      input.notes ?? null,
    );
    const id = result.lastInsertRowid as number;
    const row = this.db
      .prepare('SELECT * FROM portfolio_entries WHERE id = ?')
      .get(id) as PortfolioRow;
    return rowToEntry(row);
  }

  findByDomain(domain: string): PortfolioEntry | null {
    const row = this.db.prepare('SELECT * FROM portfolio_entries WHERE domain = ?').get(domain) as
      | PortfolioRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  findAll(): PortfolioEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM portfolio_entries ORDER BY renewal_date ASC')
      .all() as PortfolioRow[];
    return rows.map(rowToEntry);
  }

  updateVerdict(domain: string, verdict: Verdict, reason?: string): void {
    const existing = this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    this.db
      .prepare(
        `UPDATE portfolio_entries
         SET verdict = ?, verdict_reason = ?, verdict_updated_at = datetime('now'),
             updated_at = datetime('now')
         WHERE domain = ?`,
      )
      .run(verdict, reason ?? null, domain);
  }

  updateScore(domain: string, score: number, listPrice: number): void {
    const existing = this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    this.db
      .prepare(
        `UPDATE portfolio_entries
         SET current_score = ?, suggested_list_price = ?, updated_at = datetime('now')
         WHERE domain = ?`,
      )
      .run(score, listPrice, domain);
  }

  delete(domain: string): void {
    const existing = this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    this.db.prepare('DELETE FROM portfolio_entries WHERE domain = ?').run(domain);
  }
}
