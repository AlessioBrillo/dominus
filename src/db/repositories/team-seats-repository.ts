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

  async countActiveSeats(tenantId: string): Promise<number> {
    const row = await this.#db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM team_seats WHERE tenant_id = ? AND status = 'active'",
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

  async invite(tenantId: string, userId: string, role: TeamRole, invitedBy: string): Promise<void> {
    await this.#db.exec(
      `INSERT INTO team_seats (tenant_id, user_id, role, invited_by, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         role = excluded.role,
         invited_by = excluded.invited_by,
         status = 'pending',
         invited_at = datetime('now')`,
      [tenantId, userId, role, invitedBy],
    );
  }

  async acceptInvite(tenantId: string, userId: string): Promise<void> {
    await this.#db.exec(
      "UPDATE team_seats SET status = 'active', joined_at = datetime('now') WHERE tenant_id = ? AND user_id = ?",
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
