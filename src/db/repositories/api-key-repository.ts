import type { DatabaseProvider } from '../provider/interface.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

export interface ApiKeyRow {
  id: number;
  tenant_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  role: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredApiKey {
  id: number;
  tenantId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  role: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function rowToStored(row: ApiKeyRow): StoredApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    role: row.role,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
  };
}

export class ApiKeyRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async create(input: {
    tenantId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    role: string;
    expiresAt: string | null;
  }): Promise<StoredApiKey> {
    const result = await this.db.exec(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, role, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.tenantId,
        input.name,
        input.keyHash,
        input.keyPrefix,
        input.role,
        input.expiresAt ?? null,
      ],
    );
    const id = result.lastInsertRowid as number;
    return this.findById(id) as Promise<StoredApiKey>;
  }

  async findById(id: number): Promise<StoredApiKey | null> {
    const row = await this.db.queryOne<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?',
      [id, resolveTenantId()],
    );
    return row ? rowToStored(row) : null;
  }

  async findByPrefix(prefix: string): Promise<StoredApiKey | null> {
    const row = await this.db.queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE key_prefix = ?', [
      prefix,
    ]);
    return row ? rowToStored(row) : null;
  }

  async findByTenant(tenantId: string): Promise<StoredApiKey[]> {
    const rows = await this.db.query<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
      [tenantId],
    );
    return rows.map(rowToStored);
  }

  async updateLastUsed(id: number): Promise<void> {
    await this.db.exec(
      `UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id],
    );
  }

  async revoke(id: number): Promise<void> {
    await this.db.exec('DELETE FROM api_keys WHERE id = ? AND tenant_id = ?', [
      id,
      resolveTenantId(),
    ]);
  }
}
