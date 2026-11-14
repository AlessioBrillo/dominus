// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export type SignupVerificationPurpose = 'signup' | 'recovery';

export interface SignupVerification {
  id: number;
  tenantId: string;
  email: string;
  /** SHA-256 of the single-use token. The token itself is never stored. */
  tokenHash: string;
  purpose: SignupVerificationPurpose;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface SignupVerificationRow {
  id: number;
  tenant_id: string;
  email: string;
  token_hash: string;
  purpose: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

function verificationFromRow(row: SignupVerificationRow): SignupVerification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    tokenHash: row.token_hash,
    purpose: row.purpose as SignupVerificationPurpose,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

/**
 * The single-use tokens of the signup verification and of the key recovery.
 *
 * The table is control-plane on purpose: the token is looked up BEFORE any
 * tenant context exists (the caller is not authenticated yet), exactly like
 * team_invitations.
 */
export class SignupVerificationRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async create(input: {
    tenantId: string;
    email: string;
    tokenHash: string;
    purpose: SignupVerificationPurpose;
    expiresAt: string;
  }): Promise<SignupVerification> {
    const row = await this.#db.queryOne<SignupVerificationRow>(
      `INSERT INTO signup_verifications (tenant_id, email, token_hash, purpose, expires_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
      [input.tenantId, input.email, input.tokenHash, input.purpose, input.expiresAt],
    );
    if (!row) throw new Error('The verification token could not be stored');
    return verificationFromRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<SignupVerification | undefined> {
    const row = await this.#db.queryOne<SignupVerificationRow>(
      'SELECT * FROM signup_verifications WHERE token_hash = ?',
      [tokenHash],
    );
    return row ? verificationFromRow(row) : undefined;
  }

  /** The latest unconsumed token of a tenant/email pair, if any. */
  async findPending(
    tenantId: string,
    email: string,
    purpose: SignupVerificationPurpose,
  ): Promise<SignupVerification | undefined> {
    const row = await this.#db.queryOne<SignupVerificationRow>(
      `SELECT * FROM signup_verifications
       WHERE tenant_id = ? AND email = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY id DESC`,
      [tenantId, email, purpose],
    );
    return row ? verificationFromRow(row) : undefined;
  }

  /**
   * Consume a token atomically: the UPDATE only matches a row that is still
   * unconsumed, so a link clicked twice (or forwarded and clicked by two
   * people) works exactly once.
   */
  async consume(id: number): Promise<boolean> {
    const result = await this.#db.exec(
      'UPDATE signup_verifications SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL',
      [id],
    );
    return result.changes > 0;
  }

  /** Drop the expired tokens. Called by the prune job. */
  async deleteExpired(): Promise<number> {
    const result = await this.#db.exec('DELETE FROM signup_verifications WHERE expires_at < ?', [
      new Date().toISOString(),
    ]);
    return result.changes;
  }

  /**
   * Remove the workspaces that were never verified.
   *
   * A workspace is "unverified" when its only seat is still pending: nobody
   * ever proved the address, so nobody ever received a key. The rows are
   * removed in the reverse order of their creation (token, seat,
   * subscription).
   */
  async deleteUnverifiedWorkspaces(cutoff: string): Promise<number> {
    const rows = await this.#db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM team_seats
       WHERE status = 'pending'
         AND email_verified_at IS NULL
         AND invited_at < ?`,
      [cutoff],
    );
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
    let removed = 0;

    for (const tenantId of tenantIds) {
      await this.#db.transaction(async (db) => {
        await db.exec('DELETE FROM signup_verifications WHERE tenant_id = ?', [tenantId]);
        await db.exec('DELETE FROM team_seats WHERE tenant_id = ?', [tenantId]);
        await db.exec('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [tenantId]);
      });
      removed += 1;
    }

    return removed;
  }
}
