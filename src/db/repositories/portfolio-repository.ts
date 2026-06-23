import type { DatabaseProvider } from '../provider/interface.js';
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
  constructor(private readonly db: DatabaseProvider) {}

  async insert(input: AddPortfolioEntryInput): Promise<PortfolioEntry> {
    const existing = await this.findByDomain(input.domain);
    if (existing !== null) {
      throw new DuplicateDomainError(input.domain);
    }

    const result = await this.db.exec(
      `INSERT INTO portfolio_entries
       (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.domain,
        input.tld,
        input.acquiredAt,
        input.renewalDate,
        input.acquisitionCost,
        input.renewalCost,
        input.registrar,
        input.notes ?? null,
      ],
    );
    const id = result.lastInsertRowid as number;
    const row = await this.db.queryOne<PortfolioRow>('SELECT * FROM portfolio_entries WHERE id = ?', [
      id,
    ]);
    return rowToEntry(row!);
  }

  async findByDomain(domain: string): Promise<PortfolioEntry | null> {
    const row = await this.db.queryOne<PortfolioRow>('SELECT * FROM portfolio_entries WHERE domain = ?', [
      domain,
    ]);
    return row ? rowToEntry(row) : null;
  }

  async findAll(): Promise<PortfolioEntry[]> {
    const rows = await this.db.query<PortfolioRow>(
      'SELECT * FROM portfolio_entries ORDER BY renewal_date ASC',
    );
    return rows.map(rowToEntry);
  }

  async updateVerdict(domain: string, verdict: Verdict, reason?: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec(
      `UPDATE portfolio_entries
       SET verdict = ?, verdict_reason = ?, verdict_updated_at = datetime('now'),
           updated_at = datetime('now')
       WHERE domain = ?`,
      [verdict, reason ?? null, domain],
    );
  }

  async updateScore(domain: string, score: number, listPrice: number): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec(
      `UPDATE portfolio_entries
       SET current_score = ?, suggested_list_price = ?, updated_at = datetime('now')
       WHERE domain = ?`,
      [score, listPrice, domain],
    );
  }

  async updateCosts(domain: string, acquisitionCost?: number, renewalCost?: number): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    const sets: string[] = [];
    const params: (number | string)[] = [];
    if (acquisitionCost !== undefined) {
      sets.push('acquisition_cost = ?');
      params.push(acquisitionCost);
    }
    if (renewalCost !== undefined) {
      sets.push('renewal_cost = ?');
      params.push(renewalCost);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(domain);
    await this.db.exec(`UPDATE portfolio_entries SET ${sets.join(', ')} WHERE domain = ?`, params);
  }

  async delete(domain: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec('DELETE FROM portfolio_entries WHERE domain = ?', [domain]);
  }
}
