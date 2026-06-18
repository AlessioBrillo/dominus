import type { DatabaseProvider } from '../provider/interface.js';
import type { DomainCandidate, CandidateStatus, CandidateSource } from '../../types/candidate.js';

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

  findAll(limit = 50): DomainCandidate[] {
    const rows = this.db.query<CandidateRow>(
      'SELECT * FROM candidates ORDER BY updated_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(rowToCandidate);
  }

  insert(candidate: DomainCandidate): DomainCandidate {
    const result = this.db.exec(
      `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        candidate.domain,
        candidate.tld,
        candidate.source,
        candidate.status,
        candidate.isPremium ? 1 : 0,
        candidate.pipelineRunId,
      ],
    );
    return { ...candidate, id: result.lastInsertRowid as number };
  }

  findById(id: number): DomainCandidate | null {
    const row = this.db.queryOne<CandidateRow>('SELECT * FROM candidates WHERE id = ?', [id]);
    return row ? rowToCandidate(row) : null;
  }

  findByDomain(domain: string): DomainCandidate | null {
    const row = this.db.queryOne<CandidateRow>('SELECT * FROM candidates WHERE domain = ?', [
      domain,
    ]);
    return row ? rowToCandidate(row) : null;
  }

  updateStatus(id: number, status: CandidateStatus): void {
    this.db.exec(`UPDATE candidates SET status = ?, updated_at = datetime('now') WHERE id = ?`, [
      status,
      id,
    ]);
  }

  findByRunId(runId: string): DomainCandidate[] {
    const rows = this.db.query<CandidateRow>('SELECT * FROM candidates WHERE pipeline_run_id = ?', [
      runId,
    ]);
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
  pruneRescoreCandidates(before: string): number {
    const result = this.db.exec(
      `DELETE FROM candidates
       WHERE source = 'portfolio_rescore' AND created_at < ?
         AND id NOT IN (
           SELECT candidate_id FROM scoring_runs WHERE candidate_id IS NOT NULL
         )`,
      [before],
    );
    return Number(result.changes);
  }

  /** Count of portfolio_rescore candidates created before the given date. */
  countRescoreCandidates(before: string): number {
    const row = this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM candidates
       WHERE source = 'portfolio_rescore' AND created_at < ?`,
      [before],
    );
    return row!.n;
  }

  upsert(candidate: DomainCandidate): DomainCandidate {
    const row = this.db.queryOne<{ id: number }>(
      `INSERT INTO candidates
         (domain, tld, source, status, dns_status, rdap_status, is_premium, pipeline_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      ],
    );

    return { ...candidate, id: row!.id };
  }
}
