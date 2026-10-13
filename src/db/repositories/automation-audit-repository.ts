// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  AutomationAuditEntry,
  AutomationAuditRow,
  NewAutomationAuditEntry,
} from '../../types/automation.js';
import { automationAuditFromRow } from '../../types/automation.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

/**
 * Audit trail of the post-acquisition automation pipeline (ADR-0083).
 *
 * Records what the system did autonomously: run started, per-step
 * transitions, kill-switch refusals. The `actor` field is the trigger
 * source (purchase, acquisition, manual, pipeline_run) or 'operator' for
 * API/CLI-driven re-runs.
 */
export class AutomationAuditRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(entry: NewAutomationAuditEntry): Promise<void> {
    await this.db.exec(
      `INSERT INTO automation_audit (action, domain, actor, detail_json, tenant_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        entry.action,
        entry.domain ?? null,
        entry.actor ?? 'system',
        entry.detail ? JSON.stringify(entry.detail) : null,
        resolveTenantId(),
      ],
    );
  }

  async listRecent(limit: number = 100): Promise<AutomationAuditEntry[]> {
    const rows = await this.db.query<AutomationAuditRow>(
      `SELECT id, action, domain, actor, detail_json, created_at
       FROM automation_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
      [resolveTenantId(), limit],
    );
    return rows.map(automationAuditFromRow);
  }

  async findByDomain(domain: string, limit: number = 100): Promise<AutomationAuditEntry[]> {
    const rows = await this.db.query<AutomationAuditRow>(
      `SELECT id, action, domain, actor, detail_json, created_at
       FROM automation_audit WHERE domain = ? AND tenant_id = ? ORDER BY id DESC LIMIT ?`,
      [domain, resolveTenantId(), limit],
    );
    return rows.map(automationAuditFromRow);
  }

  /** Retention pass for the data-prune job. Returns the number of rows deleted. */
  async pruneOlderThan(cutoff: string): Promise<number> {
    const result = await this.db.exec('DELETE FROM automation_audit WHERE created_at < ?', [
      cutoff,
    ]);
    return Number(result.changes);
  }
}
