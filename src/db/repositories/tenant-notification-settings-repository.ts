// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export interface TenantNotificationSettingsRow {
  tenant_id: string;
  email: string | null;
  webhook_url_encrypted: string | null;
  telegram_chat_id: string | null;
  enabled: number | boolean;
  created_at: string;
  updated_at: string;
}

export interface TenantNotificationSettings {
  tenantId: string;
  email: string | null;
  /** The encrypted webhook URL. Decrypted by the notification service. */
  webhookUrlEncrypted: string | null;
  telegramChatId: string | null;
  enabled: boolean;
  updatedAt: string;
}

function settingsFromRow(row: TenantNotificationSettingsRow): TenantNotificationSettings {
  return {
    tenantId: row.tenant_id,
    email: row.email,
    webhookUrlEncrypted: row.webhook_url_encrypted,
    telegramChatId: row.telegram_chat_id,
    enabled: row.enabled === true || row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Where a tenant wants to be told about its own domains.
 *
 * One row per tenant. Control-plane table: the row is read before the
 * tenant context is established (the scheduler resolves the channels of
 * the tenant it is about to run a job for), and it holds a secret (the
 * webhook URL) that is encrypted with the operator master key.
 */
export class TenantNotificationSettingsRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async findByTenant(tenantId: string): Promise<TenantNotificationSettings | undefined> {
    const row = await this.#db.queryOne<TenantNotificationSettingsRow>(
      'SELECT * FROM tenant_notification_settings WHERE tenant_id = ?',
      [tenantId],
    );
    return row ? settingsFromRow(row) : undefined;
  }

  /** The settings of every tenant that has at least one channel. */
  async listEnabled(): Promise<TenantNotificationSettings[]> {
    const rows = await this.#db.query<TenantNotificationSettingsRow>(
      'SELECT * FROM tenant_notification_settings WHERE enabled = 1',
    );
    return rows.map(settingsFromRow);
  }

  async save(input: {
    tenantId: string;
    email: string | null;
    webhookUrlEncrypted: string | null;
    telegramChatId: string | null;
    enabled: boolean;
  }): Promise<void> {
    await this.#db.exec(
      `INSERT INTO tenant_notification_settings
         (tenant_id, email, webhook_url_encrypted, telegram_chat_id, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id) DO UPDATE SET
         email = excluded.email,
         webhook_url_encrypted = excluded.webhook_url_encrypted,
         telegram_chat_id = excluded.telegram_chat_id,
         enabled = excluded.enabled,
         updated_at = CURRENT_TIMESTAMP`,
      [
        input.tenantId,
        input.email,
        input.webhookUrlEncrypted,
        input.telegramChatId,
        input.enabled ? 1 : 0,
      ],
    );
  }

  async delete(tenantId: string): Promise<boolean> {
    const result = await this.#db.exec(
      'DELETE FROM tenant_notification_settings WHERE tenant_id = ?',
      [tenantId],
    );
    return result.changes > 0;
  }
}
