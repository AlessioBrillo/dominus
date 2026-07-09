import type { DatabaseProvider } from '../provider/interface.js';
import type { PortfolioEntry, AddPortfolioEntryInput, Verdict } from '../../types/portfolio.js';
import { DuplicateDomainError, DomainNotFoundError } from '../../types/errors.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

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
  last_rdap_verified_at: string | null;
  last_whois_renewal_date: string | null;
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
    lastRdapVerifiedAt: row.last_rdap_verified_at ?? undefined,
    lastWhoisRenewalDate: row.last_whois_renewal_date ?? undefined,
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

    const tid = resolveTenantId();
    const result = await this.db.exec(
      `INSERT INTO portfolio_entries
       (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar, notes, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.domain,
        input.tld,
        input.acquiredAt,
        input.renewalDate,
        input.acquisitionCost,
        input.renewalCost,
        input.registrar,
        input.notes ?? null,
        tid,
      ],
    );
    const id = result.lastInsertRowid as number;
    const row = await this.db.queryOne<PortfolioRow>(
      'SELECT * FROM portfolio_entries WHERE id = ? AND tenant_id = ?',
      [id, tid],
    );
    return rowToEntry(row!);
  }

  async findByDomain(domain: string): Promise<PortfolioEntry | null> {
    const row = await this.db.queryOne<PortfolioRow>(
      'SELECT * FROM portfolio_entries WHERE domain = ? AND tenant_id = ?',
      [domain, resolveTenantId()],
    );
    return row ? rowToEntry(row) : null;
  }

  async findAll(): Promise<PortfolioEntry[]> {
    const rows = await this.db.query<PortfolioRow>(
      'SELECT * FROM portfolio_entries WHERE tenant_id = ? ORDER BY renewal_date ASC',
      [resolveTenantId()],
    );
    return rows.map(rowToEntry);
  }

  async updateVerdict(domain: string, verdict: Verdict, reason?: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec(
      `UPDATE portfolio_entries
       SET verdict = ?, verdict_reason = ?, verdict_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE domain = ? AND tenant_id = ?`,
      [verdict, reason ?? null, domain, resolveTenantId()],
    );
  }

  async updateScore(domain: string, score: number, listPrice: number): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec(
      `UPDATE portfolio_entries
       SET current_score = ?, suggested_list_price = ?, updated_at = CURRENT_TIMESTAMP
       WHERE domain = ? AND tenant_id = ?`,
      [score, listPrice, domain, resolveTenantId()],
    );
  }

  async updateCosts(domain: string, acquisitionCost?: number, renewalCost?: number): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    const tid = resolveTenantId();
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
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(domain);
    params.push(tid);
    await this.db.exec(
      `UPDATE portfolio_entries SET ${sets.join(', ')} WHERE domain = ? AND tenant_id = ?`,
      params,
    );
  }

  async updateNotes(domain: string, notes: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec(
      `UPDATE portfolio_entries SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND tenant_id = ?`,
      [notes, domain, resolveTenantId()],
    );
  }

  async updateVerificationTimestamp(domain: string, whoisRenewalDate?: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    const tid = resolveTenantId();
    const sets: string[] = [
      "last_rdap_verified_at = datetime('now')",
      'updated_at = CURRENT_TIMESTAMP',
    ];
    const params: (string | number)[] = [];
    if (whoisRenewalDate !== undefined) {
      sets.push('last_whois_renewal_date = ?');
      params.push(whoisRenewalDate);
    }
    params.push(domain);
    params.push(tid);
    await this.db.exec(
      `UPDATE portfolio_entries SET ${sets.join(', ')} WHERE domain = ? AND tenant_id = ?`,
      params,
    );
  }

  /**
   * Find portfolio entries with renewal within the given number of days
   * and no recent RDAP verification, sorted by oldest verification first.
   * Used by the portfolio healthcheck worker to prioritise domains that
   * are both due for renewal and have stale verification data.
   */
  async getExpiringInDays(days: number, limit: number = 100): Promise<PortfolioEntry[]> {
    const tid = resolveTenantId();
    const rows = await this.db.query<PortfolioRow>(
      `SELECT * FROM portfolio_entries
       WHERE tenant_id = ?
         AND datetime(renewal_date) <= datetime('now', '+' || ? || ' days')
         AND (last_rdap_verified_at IS NULL
              OR datetime(last_rdap_verified_at) < datetime('now', '-30 days'))
       ORDER BY last_rdap_verified_at ASC NULLS FIRST
       LIMIT ?`,
      [tid, days, limit],
    );
    return rows.map(rowToEntry);
  }

  async delete(domain: string): Promise<void> {
    const existing = await this.findByDomain(domain);
    if (existing === null) throw new DomainNotFoundError(domain);
    await this.db.exec('DELETE FROM portfolio_entries WHERE domain = ? AND tenant_id = ?', [
      domain,
      resolveTenantId(),
    ]);
  }
}
