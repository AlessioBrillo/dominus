// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface TeamMember {
  userId: string;
  role: 'admin' | 'member';
  status: 'active' | 'pending';
  invitedAt: string;
  joinedAt: string | null;
}

export interface TeamSummary {
  tenantId: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  seatLimit: number | null;
  activeSeats: number;
  pendingSeats: number;
  members: TeamMember[];
}

export async function fetchTeamSummary(): Promise<TeamSummary> {
  return api.get<TeamSummary>('/team');
}

export async function inviteMember(userId: string, role: 'admin' | 'member'): Promise<void> {
  await api.post('/team/invite', { userId, role });
}

export async function updateMemberRole(userId: string, role: 'admin' | 'member'): Promise<void> {
  await api.patch(`/team/${encodeURIComponent(userId)}/role`, { role });
}

export async function removeMember(userId: string): Promise<void> {
  await api.delete(`/team/${encodeURIComponent(userId)}`);
}
