import type { DatabaseProvider } from '../provider/interface.js';
import type { DomainCandidate, CandidateStatus, CandidateSource } from '../../types/candidate.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

interface CandidateRow {
  id: number;
  domain: string;
  tld: string;
  source: string;
  status: string;
  dns_status: string | null;
  rdap_status: string | null;
  is_premium: number;
  pipeline_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCandidate(row: CandidateRow): DomainCandidate {
  return {
    id: row.id,
    domain: row.domain,
    tld: row.tld,
    source: row.source as CandidateSource,
    status: row.status as CandidateStatus,
    dnsStatus: row.dns_status ?? undefined,
    rdapStatus: row.rdap_status ?? undefined,
    isPremium: row.is_premium === 1,
    pipelineRunId: row.pipeline_run_id ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CandidateRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async findAll(limit = 50): Promise<DomainCandidate[]> {
    const rows = await this.db.query<CandidateRow>(
      'SELECT * FROM candidates WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
      [resolveTenantId(), limit],
    );
    return rows.map(rowToCandidate);
  }

  async insert(candidate: DomainCandidate): Promise<DomainCandidate> {
    const tid = resolveTenantId();
    const result = await this.db.exec(
      `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        candidate.domain,
        candidate.tld,
        candidate.source,
        candidate.status,
        candidate.isPremium ? 1 : 0,
        candidate.pipelineRunId,
        tid,
      ],
    );
    return { ...candidate, id: result.lastInsertRowid as number };
  }

  async findById(id: number): Promise<DomainCandidate | null> {
    const row = await this.db.queryOne<CandidateRow>(
      'SELECT * FROM candidates WHERE id = ? AND tenant_id = ?',
      [id, resolveTenantId()],
    );
    return row ? rowToCandidate(row) : null;
  }

  async findByDomain(domain: string): Promise<DomainCandidate | null> {
    const row = await this.db.queryOne<CandidateRow>(
      'SELECT * FROM candidates WHERE domain = ? AND tenant_id = ?',
      [domain, resolveTenantId()],
    );
    return row ? rowToCandidate(row) : null;
  }

  async updateStatus(id: number, status: CandidateStatus): Promise<void> {
    await this.db.exec(
      `UPDATE candidates SET status = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
      [status, id, resolveTenantId()],
    );
  }

  async findByRunId(runId: string): Promise<DomainCandidate[]> {
    const rows = await this.db.query<CandidateRow>(
      'SELECT * FROM candidates WHERE pipeline_run_id = ? AND tenant_id = ?',
      [runId, resolveTenantId()],
    );
    return rows.map(rowToCandidate);
  }

  /**
   * Upsert a candidate by domain (the UNIQUE key). On conflict, updates every
   * mutable field so that re-running the pipeline reflects the latest status.
   * Returns the persisted candidate including the resolved `id`.
   */
  /**
   * Prune portfolio_rescore candidates created before the given cutoff date.
   * These synthetic candidates accumulate on every rescore run and are not
   * needed for pipeline history. Returns the number of rows removed.
   */
  async pruneRescoreCandidates(before: string): Promise<number> {
    const tid = resolveTenantId();
    const result = await this.db.exec(
      `DELETE FROM candidates
       WHERE tenant_id = ? AND source = 'portfolio_rescore' AND created_at < ?
         AND id NOT IN (
           SELECT candidate_id FROM scoring_runs sr
           JOIN candidates c ON c.id = sr.candidate_id
           WHERE sr.candidate_id IS NOT NULL AND c.tenant_id = ?
         )`,
      [tid, before, tid],
    );
    return Number(result.changes);
  }

  /** Count of portfolio_rescore candidates created before the given date. */
  async countRescoreCandidates(before: string): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM candidates
       WHERE tenant_id = ? AND source = 'portfolio_rescore' AND created_at < ?`,
      [resolveTenantId(), before],
    );
    return row!.n;
  }

  async upsert(candidate: DomainCandidate): Promise<DomainCandidate> {
    const tid = resolveTenantId();
    const row = await this.db.queryOne<{ id: number }>(
      `INSERT INTO candidates
         (domain, tld, source, status, dns_status, rdap_status, is_premium, pipeline_run_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         status          = excluded.status,
         dns_status      = excluded.dns_status,
         rdap_status     = excluded.rdap_status,
         is_premium      = excluded.is_premium,
         pipeline_run_id = excluded.pipeline_run_id,
         updated_at      = datetime('now')
       RETURNING id`,
      [
        candidate.domain,
        candidate.tld,
        candidate.source,
        candidate.status,
        candidate.dnsStatus ?? null,
        candidate.rdapStatus ?? null,
        candidate.isPremium ? 1 : 0,
        candidate.pipelineRunId,
        tid,
      ],
    );

    return { ...candidate, id: row!.id };
  }
}
