// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface TeamMember {
  userId: string;
  role: 'admin' | 'member';
  status: 'active' | 'pending';
  invitedAt: string;
  joinedAt: string | null;
}

export interface TeamInvitation {
  id: number;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InviteResult {
  invitation: { id: number; email: string; role: 'admin' | 'member'; expiresAt: string };
  /** Single-use link; shown once. Share it by hand when `emailed` is false. */
  link: string;
  emailed: boolean;
}

export interface TeamSummary {
  tenantId: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  seatLimit: number | null;
  activeSeats: number;
  pendingSeats: number;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

export async function fetchTeamSummary(): Promise<TeamSummary> {
  return api.get<TeamSummary>('/team');
}

export function inviteByEmail(email: string, role: 'admin' | 'member'): Promise<InviteResult> {
  return api.post<InviteResult>('/team/invite', { email, role });
}

export async function revokeInvitation(id: number): Promise<void> {
  await api.delete(`/team/invitations/${id}`);
}

/** Redeem an invitation link; the server re-issues the session for the team's tenant. */
export function acceptInvitation(token: string): Promise<{ tenantId: string; role: string }> {
  return api.post<{ tenantId: string; role: string }>('/auth/oidc/accept-invitation', { token });
}

export async function updateMemberRole(userId: string, role: 'admin' | 'member'): Promise<void> {
  await api.patch(`/team/${encodeURIComponent(userId)}/role`, { role });
}

export async function removeMember(userId: string): Promise<void> {
  await api.delete(`/team/${encodeURIComponent(userId)}`);
}
