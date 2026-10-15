// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  TenantAutomationSettings,
  TenantAutomationSettingsRow,
  TenantAutomationSettingsUpdate,
} from '../../types/automation.js';
import {
  DEFAULT_TENANT_AUTOMATION_SETTINGS,
  tenantAutomationSettingsFromRow,
} from '../../types/automation.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

/**
 * Per-tenant automation opt-in (ADR-0083, Phase 0).
 *
 * Stores the tenant's own kill switch and dry-run preference. The row is
 * created on first write; before that the conservative defaults
 * (disabled, dry-run) apply, so a tenant is opted out until it says so.
 * Every query filters on the resolved tenant id — the same
 * repository-enforced isolation as the other post-1.0 tables.
 */
export class TenantAutomationSettingsRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Current tenant settings, or the conservative defaults when never written. */
  async get(): Promise<TenantAutomationSettings> {
    const row = await this.db.queryOne<TenantAutomationSettingsRow>(
      `SELECT tenant_id, enabled, dry_run, updated_at
        FROM tenant_automation_settings WHERE tenant_id = ?`,
      [resolveTenantId()],
    );
    return row ? tenantAutomationSettingsFromRow(row) : { ...DEFAULT_TENANT_AUTOMATION_SETTINGS };
  }

  /** Merge a partial update into the current settings and persist the result. */
  async set(update: TenantAutomationSettingsUpdate): Promise<TenantAutomationSettings> {
    const current = await this.get();
    const next: TenantAutomationSettings = {
      enabled: update.enabled ?? current.enabled,
      dryRun: update.dryRun ?? current.dryRun,
    };

    await this.db.exec(
      `INSERT INTO tenant_automation_settings (tenant_id, enabled, dry_run, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = excluded.enabled,
         dry_run = excluded.dry_run,
         updated_at = CURRENT_TIMESTAMP`,
      [resolveTenantId(), next.enabled ? 1 : 0, next.dryRun ? 1 : 0],
    );

    return next;
  }
}
