// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export interface MagicLinkToken {
  id: number;
  tenantId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface MagicLinkTokenRow {
  id: number;
  tenant_id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

function tokenFromRow(row: MagicLinkTokenRow): MagicLinkToken {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

/** Control-plane tokens: consumed before any tenant context exists. */
export class MagicLinkTokenRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async create(input: {
    tenantId: string;
    email: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<MagicLinkToken> {
    const row = await this.#db.queryOne<MagicLinkTokenRow>(
      `INSERT INTO magic_link_tokens (tenant_id, email, token_hash, expires_at)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
      [input.tenantId, input.email, input.tokenHash, input.expiresAt],
    );
    if (!row) throw new Error('The magic-link token could not be stored');
    return tokenFromRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<MagicLinkToken | undefined> {
    const row = await this.#db.queryOne<MagicLinkTokenRow>(
      'SELECT * FROM magic_link_tokens WHERE token_hash = ?',
      [tokenHash],
    );
    return row ? tokenFromRow(row) : undefined;
  }

  /** Atomic single-use: two clicks on the same link cannot both mint a session. */
  async consume(id: number): Promise<boolean> {
    const result = await this.#db.exec(
      'UPDATE magic_link_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL',
      [id],
    );
    return result.changes > 0;
  }

  async deleteById(id: number): Promise<void> {
    await this.#db.exec('DELETE FROM magic_link_tokens WHERE id = ?', [id]);
  }

  async deleteExpired(): Promise<number> {
    const result = await this.#db.exec('DELETE FROM magic_link_tokens WHERE expires_at < ?', [
      new Date().toISOString(),
    ]);
    return result.changes;
  }
}
