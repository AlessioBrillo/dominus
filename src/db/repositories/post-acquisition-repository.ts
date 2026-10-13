// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  NewPostAcquisitionStep,
  PostAcquisitionStep,
  PostAcquisitionStepName,
  PostAcquisitionStepRow,
  PostAcquisitionStepStatus,
} from '../../types/automation.js';
import { postAcquisitionStepFromRow } from '../../types/automation.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

const COLUMNS =
  'id, domain, step, status, attempts, source, pipeline_run_id, detail_json, last_error, created_at, updated_at';

/**
 * Journal of the post-acquisition automation pipeline (ADR-0083).
 *
 * One row per (domain, step, tenant). `upsert` is the idempotent entry
 * point: the pipeline re-running after a crash or an operator re-run
 * updates the existing row instead of duplicating history.
 */
export class PostAcquisitionRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Insert-or-ignore the journal row for a domain+step, returning the current row. */
  async upsert(input: NewPostAcquisitionStep): Promise<PostAcquisitionStep> {
    await this.db.exec(
      `INSERT INTO post_acquisition_steps (domain, step, source, pipeline_run_id, tenant_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (domain, step, tenant_id) DO NOTHING`,
      [input.domain, input.step, input.source, input.pipelineRunId ?? null, resolveTenantId()],
    );
    const row = await this.findByDomainAndStep(input.domain, input.step);
    if (row === null) {
      throw new Error(
        `post_acquisition_steps row for ${input.domain}/${input.step} not found after upsert`,
      );
    }
    return row;
  }

  async findByDomainAndStep(
    domain: string,
    step: PostAcquisitionStepName,
  ): Promise<PostAcquisitionStep | null> {
    const row = await this.db.queryOne<PostAcquisitionStepRow>(
      `SELECT ${COLUMNS} FROM post_acquisition_steps WHERE domain = ? AND step = ? AND tenant_id = ?`,
      [domain, step, resolveTenantId()],
    );
    return row ? postAcquisitionStepFromRow(row) : null;
  }

  async findByDomain(domain: string): Promise<PostAcquisitionStep[]> {
    const rows = await this.db.query<PostAcquisitionStepRow>(
      `SELECT ${COLUMNS} FROM post_acquisition_steps WHERE domain = ? AND tenant_id = ? ORDER BY id ASC`,
      [domain, resolveTenantId()],
    );
    return rows.map(postAcquisitionStepFromRow);
  }

  async listRecent(
    options: { status?: PostAcquisitionStepStatus; limit?: number } = {},
  ): Promise<PostAcquisitionStep[]> {
    const limit = options.limit ?? 100;
    // Order by id, not updated_at: SQLite timestamps have second granularity
    // and rows updated within the same second sort non-deterministically.
    if (options.status) {
      const rows = await this.db.query<PostAcquisitionStepRow>(
        `SELECT ${COLUMNS} FROM post_acquisition_steps WHERE status = ? AND tenant_id = ?
         ORDER BY id DESC LIMIT ?`,
        [options.status, resolveTenantId(), limit],
      );
      return rows.map(postAcquisitionStepFromRow);
    }
    const rows = await this.db.query<PostAcquisitionStepRow>(
      `SELECT ${COLUMNS} FROM post_acquisition_steps WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
      [resolveTenantId(), limit],
    );
    return rows.map(postAcquisitionStepFromRow);
  }

  async incrementAttempts(id: number): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [id, resolveTenantId()],
    );
  }

  async markDone(id: number, detail?: Record<string, unknown> | null): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps
       SET status = 'done', last_error = NULL, detail_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [detail ? JSON.stringify(detail) : null, id, resolveTenantId()],
    );
  }

  async markSkipped(id: number, reason: string): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps
       SET status = 'skipped', last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [reason, id, resolveTenantId()],
    );
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps
       SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [error, id, resolveTenantId()],
    );
  }

  /** Reset a step to pending so the next pipeline run executes it again. */
  async resetStep(domain: string, step: PostAcquisitionStepName): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps
       SET status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE domain = ? AND step = ? AND tenant_id = ?`,
      [domain, step, resolveTenantId()],
    );
  }

  /** Reset every step of a domain (full pipeline re-run). */
  async resetDomain(domain: string): Promise<void> {
    await this.db.exec(
      `UPDATE post_acquisition_steps
       SET status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE domain = ? AND tenant_id = ?`,
      [domain, resolveTenantId()],
    );
  }
}
