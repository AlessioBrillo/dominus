// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export type TeamRole = 'owner' | 'admin' | 'member';

export type TeamSeatStatus = 'pending' | 'active' | 'removed';

export interface TeamSeat {
  id: number;
  tenantId: string;
  userId: string;
  role: TeamRole;
  invitedBy: string | null;
  invitedAt: string;
  joinedAt: string | null;
  status: TeamSeatStatus;
  /**
   * When the email that identifies this seat was proven by its owner.
   *
   * A seat created by the self-serve signup is held by an EMAIL: at that
   * moment there is no identity-provider subject, and the address was never
   * proven. Until this timestamp is set, the seat cannot be claimed by a
   * single-sign-on identity — otherwise whoever typed the address of someone
   * else would take over that person's workspace (pre-account takeover).
   */
  emailVerifiedAt: string | null;
}

interface TeamSeatRow {
  id: number;
  tenant_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  invited_at: string;
  joined_at: string | null;
  status: string;
  email_verified_at: string | null;
}

function teamSeatFromRow(row: TeamSeatRow): TeamSeat {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role as TeamRole,
    invitedBy: row.invited_by,
    invitedAt: row.invited_at,
    joinedAt: row.joined_at,
    status: row.status as TeamSeatStatus,
    emailVerifiedAt: row.email_verified_at ?? null,
  };
}

export class TeamSeatsRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async findByTenantId(tenantId: string): Promise<TeamSeat[]> {
    const rows = await this.#db.query<TeamSeatRow>(
      'SELECT * FROM team_seats WHERE tenant_id = ? ORDER BY invited_at ASC',
      [tenantId],
    );
    return rows.map(teamSeatFromRow);
  }

  async findActiveByTenantId(tenantId: string): Promise<TeamSeat[]> {
    const rows = await this.#db.query<TeamSeatRow>(
      "SELECT * FROM team_seats WHERE tenant_id = ? AND status = 'active' ORDER BY invited_at ASC",
      [tenantId],
    );
    return rows.map(teamSeatFromRow);
  }

  /**
   * Active seats of a user across tenants, most recently joined first. A user
   * who accepted an invitation lands in that team on the next login (there is
   * no tenant switcher yet).
   */
  async findActiveByUserId(userId: string): Promise<TeamSeat[]> {
    const rows = await this.#db.query<TeamSeatRow>(
      "SELECT * FROM team_seats WHERE user_id = ? AND status = 'active' ORDER BY joined_at DESC, id DESC",
      [userId],
    );
    return rows.map(teamSeatFromRow);
  }

  /**
   * Every seat held by an identifier, whatever its status.
   *
   * Used by the signup flow: the pending seat of a signup that has not been
   * verified yet must be findable by its email, so the verification link can
   * activate it.
   */
  async findByUserId(userId: string): Promise<TeamSeat[]> {
    const rows = await this.#db.query<TeamSeatRow>(
      'SELECT * FROM team_seats WHERE user_id = ? ORDER BY id DESC',
      [userId],
    );
    return rows.map(teamSeatFromRow);
  }

  /**
   * The active seats held by an email address whose ownership was PROVEN.
   *
   * Only these seats may be re-linked to a single-sign-on identity: an
   * unverified signup seat proves nothing about who owns the mailbox, and
   * linking it would hand the workspace to whoever owns the address later
   * (and to whoever typed it first, in the meantime).
   *
   * The list can hold more than one seat: two workspaces may have been
   * created with the same address. The caller must treat "more than one" as
   * "do not link", never as "the most recent one".
   */
  async findActiveVerifiedByEmail(email: string): Promise<TeamSeat[]> {
    const rows = await this.#db.query<TeamSeatRow>(
      `SELECT * FROM team_seats
       WHERE user_id = ? AND status = 'active' AND email_verified_at IS NOT NULL
       ORDER BY joined_at DESC, id DESC`,
      [email],
    );
    return rows.map(teamSeatFromRow);
  }

  /** Record that the seat's email address was proven by its owner. */
  async markEmailVerified(tenantId: string, userId: string): Promise<void> {
    // CAST, not the `::text` shorthand: the same statement runs on SQLite
    // (where CURRENT_TIMESTAMP is a string) and on PostgreSQL (where it is a
    // timestamp), and COALESCE refuses to mix the two types.
    await this.#db.exec(
      `UPDATE team_seats SET email_verified_at = COALESCE(email_verified_at, CAST(CURRENT_TIMESTAMP AS TEXT))
       WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId],
    );
  }

  async countActiveSeats(tenantId: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM team_seats WHERE tenant_id = ? AND status = 'active'",
      [tenantId],
    );
    return row?.count ?? 0;
  }

  /** Active seats with admin or owner role for a tenant. */
  async countActiveAdmins(tenantId: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM team_seats WHERE tenant_id = ? AND status = 'active' AND role IN ('admin', 'owner')",
      [tenantId],
    );
    return row?.count ?? 0;
  }

  /** Seats held by active members plus outstanding invitations. */
  async countOccupiedSeats(tenantId: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM team_seats WHERE tenant_id = ? AND status IN ('active', 'pending')",
      [tenantId],
    );
    return row?.count ?? 0;
  }

  async findByTenantAndUser(tenantId: string, userId: string): Promise<TeamSeat | undefined> {
    const row = await this.#db.queryOne<TeamSeatRow>(
      'SELECT * FROM team_seats WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId],
    );
    return row ? teamSeatFromRow(row) : undefined;
  }

  /**
   * Move a seat from one user identifier to another.
   *
   * The self-serve signup creates the owner seat with the EMAIL as the user
   * identifier, because at that moment there is no identity-provider
   * subject. When the same person signs in with single sign-on, the seat is
   * re-linked to the provider subject: without it the person would land in
   * a second, empty tenant and lose sight of the workspace they created.
   */
  async relinkUser(tenantId: string, fromUserId: string, toUserId: string): Promise<void> {
    await this.#db.exec('UPDATE team_seats SET user_id = ? WHERE tenant_id = ? AND user_id = ?', [
      toUserId,
      tenantId,
      fromUserId,
    ]);
  }

  async invite(tenantId: string, userId: string, role: TeamRole, invitedBy: string): Promise<void> {
    await this.#db.exec(
      `INSERT INTO team_seats (tenant_id, user_id, role, invited_by, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         role = excluded.role,
         invited_by = excluded.invited_by,
         status = 'pending',
         invited_at = CURRENT_TIMESTAMP`,
      [tenantId, userId, role, invitedBy],
    );
  }

  async acceptInvite(tenantId: string, userId: string): Promise<void> {
    await this.#db.exec(
      "UPDATE team_seats SET status = 'active', joined_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND user_id = ?",
      [tenantId, userId],
    );
  }

  async updateRole(tenantId: string, userId: string, role: TeamRole): Promise<void> {
    await this.#db.exec('UPDATE team_seats SET role = ? WHERE tenant_id = ? AND user_id = ?', [
      role,
      tenantId,
      userId,
    ]);
  }

  async remove(tenantId: string, userId: string): Promise<void> {
    await this.#db.exec(
      "UPDATE team_seats SET status = 'removed' WHERE tenant_id = ? AND user_id = ?",
      [tenantId, userId],
    );
  }

  async hardRemove(tenantId: string, userId: string): Promise<void> {
    await this.#db.exec('DELETE FROM team_seats WHERE tenant_id = ? AND user_id = ?', [
      tenantId,
      userId,
    ]);
  }
}
