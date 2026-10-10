// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type { TeamRole } from '../../types/team.js';
import { sqlTimestamp } from '../sql-timestamp.js';

export interface TeamInvitation {
  id: number;
  tenantId: string;
  email: string;
  role: TeamRole;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

interface InvitationRow {
  id: number;
  tenant_id: string;
  email: string;
  role: string;
  invited_by: string | null;
  expires_at: string | Date;
  accepted_at: string | Date | null;
  created_at: string | Date;
}

/**
 * SQLite hands back `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker), which
 * `new Date()` would read as local time; PostgreSQL hands back a Date.
 * Normalise both to an ISO-8601 UTC string.
 */
const iso = (v: string | Date): string => {
  if (v instanceof Date) return v.toISOString();
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
};

function fromRow(r: InvitationRow): TeamInvitation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    role: r.role as TeamRole,
    invitedBy: r.invited_by,
    expiresAt: iso(r.expires_at),
    acceptedAt: r.accepted_at === null ? null : iso(r.accepted_at),
    createdAt: iso(r.created_at),
  };
}

const COLUMNS = 'id, tenant_id, email, role, invited_by, expires_at, accepted_at, created_at';

export class TeamInvitationsRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async create(input: {
    tenantId: string;
    email: string;
    role: TeamRole;
    tokenHash: string;
    invitedBy: string | null;
    expiresAt: Date;
  }): Promise<TeamInvitation> {
    const row = await this.#db.queryOne<InvitationRow>(
      `INSERT INTO team_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.email,
        input.role,
        input.tokenHash,
        input.invitedBy,
        sqlTimestamp(input.expiresAt),
      ],
    );
    return fromRow(row!);
  }

  /** Lookup by token digest. The caller checks expiry/acceptance. */
  async findByTokenHash(tokenHash: string): Promise<TeamInvitation | null> {
    const row = await this.#db.queryOne<InvitationRow>(
      `SELECT ${COLUMNS} FROM team_invitations WHERE token_hash = ?`,
      [tokenHash],
    );
    return row ? fromRow(row) : null;
  }

  /** Outstanding (unaccepted, unexpired) invitations for a tenant, newest first. */
  async listPending(tenantId: string): Promise<TeamInvitation[]> {
    const rows = await this.#db.query<InvitationRow>(
      `SELECT ${COLUMNS} FROM team_invitations
        WHERE tenant_id = ? AND accepted_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC, id DESC`,
      [tenantId, sqlTimestamp()],
    );
    return rows.map(fromRow);
  }

  async countPending(tenantId: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM team_invitations
        WHERE tenant_id = ? AND accepted_at IS NULL AND expires_at > ?`,
      [tenantId, sqlTimestamp()],
    );
    return row?.count ?? 0;
  }

  /**
   * Single-use claim: only the first caller flips accepted_at, so two
   * concurrent accepts of the same link cannot both succeed.
   */
  async claim(id: number, userId: string): Promise<boolean> {
    const res = await this.#db.exec(
      `UPDATE team_invitations
          SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ?
        WHERE id = ? AND accepted_at IS NULL AND expires_at > ?`,
      [userId, id, sqlTimestamp()],
    );
    return res.changes > 0;
  }

  /** Undo a claim when the seat could not be created afterwards. */
  async unclaim(id: number): Promise<void> {
    await this.#db.exec(
      'UPDATE team_invitations SET accepted_at = NULL, accepted_by = NULL WHERE id = ?',
      [id],
    );
  }

  async revoke(tenantId: string, id: number): Promise<boolean> {
    const res = await this.#db.exec(
      'DELETE FROM team_invitations WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL',
      [id, tenantId],
    );
    return res.changes > 0;
  }
}
