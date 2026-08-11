// SPDX-License-Identifier: AGPL-3.0-only
import type { SubscriptionPlan } from './subscription.js';

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

export interface TeamSeatRow {
  id: number;
  tenant_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  invited_at: string;
  joined_at: string | null;
  status: string;
}

export function teamSeatFromRow(row: TeamSeatRow): TeamSeat {
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

export interface TeamInviteInput {
  tenantId: string;
  userId: string;
  role?: TeamRole;
  invitedBy: string;
}

export interface TeamPlanLimits {
  seats: number;
  candidatesScored: number;
  apiCalls: number;
  domainsTracked: number;
}

export const TEAM_PLAN_LIMITS: Record<SubscriptionPlan, TeamPlanLimits> = {
  free: { seats: 1, candidatesScored: 50, apiCalls: 1000, domainsTracked: 25 },
  pro: { seats: 3, candidatesScored: 500, apiCalls: 10000, domainsTracked: 250 },
  team: { seats: 10, candidatesScored: 2500, apiCalls: 50000, domainsTracked: 1000 },
  enterprise: { seats: 0, candidatesScored: 0, apiCalls: 0, domainsTracked: 0 },
};
