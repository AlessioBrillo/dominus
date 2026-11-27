// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export interface MobileDeviceRow {
  id: number;
  tenant_id: string;
  label: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface MobileDeviceView {
  id: number;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/**
 * Device sessions are control-plane data, like API keys: the lookup by token
 * hash happens BEFORE a tenant context exists, because the token is what
 * establishes the tenant. The repository is therefore the enforcement point
 * and never accepts a caller-supplied tenant for authentication.
 */
export class MobileDeviceRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async create(input: {
    tenantId: string;
    label: string;
    tokenHash: string;
  }): Promise<MobileDeviceView> {
    const row = await this.db.queryOne<MobileDeviceRow>(
      `INSERT INTO mobile_device_sessions (tenant_id, label, token_hash)
       VALUES (?, ?, ?) RETURNING *`,
      [input.tenantId, input.label, input.tokenHash],
    );
    return toView(row!);
  }

  /** Authentication lookup. No tenant filter: the hash is a high-entropy secret. */
  async findActiveByTokenHash(tokenHash: string): Promise<MobileDeviceRow | null> {
    const row = await this.db.queryOne<MobileDeviceRow>(
      `SELECT * FROM mobile_device_sessions
       WHERE token_hash = ? AND revoked_at IS NULL`,
      [tokenHash],
    );
    return row;
  }

  async touch(id: number): Promise<void> {
    await this.db.exec('UPDATE mobile_device_sessions SET last_used_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);
  }

  async list(tenantId: string): Promise<MobileDeviceView[]> {
    const rows = await this.db.query<MobileDeviceRow>(
      'SELECT * FROM mobile_device_sessions WHERE tenant_id = ? ORDER BY id DESC',
      [tenantId],
    );
    return rows.map(toView);
  }

  async revoke(id: number, tenantId: string): Promise<boolean> {
    const result = await this.db.exec(
      'UPDATE mobile_device_sessions SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), id, tenantId],
    );
    return result.changes > 0;
  }

  async revokeAll(tenantId: string): Promise<number> {
    const result = await this.db.exec(
      'UPDATE mobile_device_sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), tenantId],
    );
    return result.changes;
  }
}

function toView(row: MobileDeviceRow): MobileDeviceView {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}
