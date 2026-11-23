// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export interface WaitlistSignup {
  id: number;
  email: string;
  consentVersion: string;
  consentAt: string;
  tokenHash: string;
  confirmedAt: string | null;
  createdAt: string;
}

interface WaitlistSignupRow {
  id: number;
  email: string;
  consent_version: string;
  consent_at: string;
  token_hash: string;
  confirmed_at: string | null;
  created_at: string;
}

function signupFromRow(row: WaitlistSignupRow): WaitlistSignup {
  return {
    id: row.id,
    email: row.email,
    consentVersion: row.consent_version,
    consentAt: row.consent_at,
    tokenHash: row.token_hash,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

/** Append-only contact list of the first-party waitlist. */
export class WaitlistSignupRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async create(input: {
    email: string;
    consentVersion: string;
    tokenHash: string;
  }): Promise<WaitlistSignup> {
    const row = await this.db.queryOne<WaitlistSignupRow>(
      `INSERT INTO waitlist_signups (email, consent_version, token_hash)
       VALUES (?, ?, ?) RETURNING *`,
      [input.email, input.consentVersion, input.tokenHash],
    );
    if (!row) throw new Error('The waitlist signup could not be stored');
    return signupFromRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<WaitlistSignup | null> {
    const row = await this.db.queryOne<WaitlistSignupRow>(
      'SELECT * FROM waitlist_signups WHERE token_hash = ?',
      [tokenHash],
    );
    return row ? signupFromRow(row) : null;
  }

  async confirm(tokenHash: string): Promise<boolean> {
    const result = await this.db.exec(
      'UPDATE waitlist_signups SET confirmed_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND confirmed_at IS NULL',
      [tokenHash],
    );
    return result.changes > 0;
  }

  async countConfirmed(): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM waitlist_signups WHERE confirmed_at IS NOT NULL',
    );
    return row?.count ?? 0;
  }

  /** Data-subject erasure: remove the address and its consent record. */
  async deleteForEmail(email: string): Promise<number> {
    const result = await this.db.exec('DELETE FROM waitlist_signups WHERE email = ?', [email]);
    return result.changes;
  }
}
