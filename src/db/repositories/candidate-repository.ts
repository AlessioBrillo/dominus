import type Database from 'better-sqlite3';
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
  constructor(private readonly db: Database.Database) {}

  findAll(limit = 50): DomainCandidate[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  insert(candidate: DomainCandidate): DomainCandidate {
    const stmt = this.db.prepare(
      `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      candidate.domain,
      candidate.tld,
      candidate.source,
      candidate.status,
      candidate.isPremium ? 1 : 0,
      candidate.pipelineRunId,
    );
    return { ...candidate, id: result.lastInsertRowid as number };
  }

  findById(id: number): DomainCandidate | null {
    const row = this.db
      .prepare('SELECT * FROM candidates WHERE id = ?')
      .get(id) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  findByDomain(domain: string): DomainCandidate | null {
    const row = this.db
      .prepare('SELECT * FROM candidates WHERE domain = ?')
      .get(domain) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  updateStatus(id: number, status: CandidateStatus): void {
    this.db
      .prepare(
        `UPDATE candidates SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, id);
  }

  findByRunId(runId: string): DomainCandidate[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates WHERE pipeline_run_id = ?')
      .all(runId) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  /**
   * Upsert a candidate by domain (the UNIQUE key). On conflict, updates every
   * mutable field so that re-running the pipeline reflects the latest status.
   * Returns the persisted candidate including the resolved `id`.
   */
  upsert(candidate: DomainCandidate): DomainCandidate {
    const row = this.db
      .prepare(
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
      )
      .get(
        candidate.domain,
        candidate.tld,
        candidate.source,
        candidate.status,
        candidate.dnsStatus ?? null,
        candidate.rdapStatus ?? null,
        candidate.isPremium ? 1 : 0,
        candidate.pipelineRunId,
      ) as { id: number };

    return { ...candidate, id: row.id };
  }
}
