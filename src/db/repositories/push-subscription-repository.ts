// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import { resolveTenantId } from '../../utils/tenant-context.js';
import type { UserConfigurableTopics } from '../../types/mobile.js';

export interface PushSubscriptionRow {
  id: number;
  tenant_id: string;
  device_session_id: number | null;
  platform: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  topics_json: string;
  expires_at: string | null;
  last_failure_at: string | null;
  created_at: string;
}

export interface PushSubscriptionView {
  id: number;
  platform: string;
  topics: UserConfigurableTopics;
  createdAt: string;
}

export interface UpsertPushSubscriptionInput {
  deviceSessionId?: number;
  platform: string;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  topics: UserConfigurableTopics;
  expiresAt?: string;
}

/**
 * Push subscriptions are RLS-protected tenant data (migration 0077).
 * Every query therefore carries the tenant id explicitly as well: the
 * repository must remain correct on SQLite, where RLS does not exist.
 */
export class PushSubscriptionRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async upsert(input: UpsertPushSubscriptionInput): Promise<PushSubscriptionView> {
    const tenantId = resolveTenantId();
    const row = await this.db.queryOne<PushSubscriptionRow>(
      `INSERT INTO push_subscriptions
         (tenant_id, device_session_id, platform, endpoint, p256dh, auth, topics_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, endpoint) DO UPDATE SET
         device_session_id = excluded.device_session_id,
         platform = excluded.platform,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         topics_json = excluded.topics_json,
         expires_at = excluded.expires_at,
         last_failure_at = NULL
       RETURNING *`,
      [
        tenantId,
        input.deviceSessionId ?? null,
        input.platform,
        input.endpoint,
        input.p256dh ?? null,
        input.auth ?? null,
        JSON.stringify(input.topics),
        input.expiresAt ?? null,
      ],
    );
    return toView(row!);
  }

  async list(tenantId: string): Promise<PushSubscriptionView[]> {
    const rows = await this.db.query<PushSubscriptionRow>(
      'SELECT * FROM push_subscriptions WHERE tenant_id = ? ORDER BY id',
      [tenantId],
    );
    return rows.map(toView);
  }

  async findForTenant(tenantId: string): Promise<PushSubscriptionRow[]> {
    return this.db.query<PushSubscriptionRow>(
      'SELECT * FROM push_subscriptions WHERE tenant_id = ? AND last_failure_at IS NULL',
      [tenantId],
    );
  }

  async remove(id: number, tenantId: string): Promise<boolean> {
    const result = await this.db.exec(
      'DELETE FROM push_subscriptions WHERE id = ? AND tenant_id = ?',
      [id, tenantId],
    );
    return result.changes > 0;
  }

  async markFailure(id: number, tenantId: string): Promise<void> {
    await this.db.exec(
      'UPDATE push_subscriptions SET last_failure_at = ? WHERE id = ? AND tenant_id = ?',
      [new Date().toISOString(), id, tenantId],
    );
  }

  async revokeForDevice(deviceSessionId: number, tenantId: string): Promise<void> {
    await this.db.exec(
      'DELETE FROM push_subscriptions WHERE device_session_id = ? AND tenant_id = ?',
      [deviceSessionId, tenantId],
    );
  }
}

function toView(row: PushSubscriptionRow): PushSubscriptionView {
  const fallback: UserConfigurableTopics = { renewal: true, watchlist: true, verdict: true };
  let topics: UserConfigurableTopics;
  try {
    const parsed = JSON.parse(row.topics_json) as Partial<UserConfigurableTopics>;
    topics = {
      renewal: parsed.renewal ?? fallback.renewal,
      watchlist: parsed.watchlist ?? fallback.watchlist,
      verdict: parsed.verdict ?? fallback.verdict,
    };
  } catch {
    topics = fallback;
  }
  return { id: row.id, platform: row.platform, topics, createdAt: row.created_at };
}
