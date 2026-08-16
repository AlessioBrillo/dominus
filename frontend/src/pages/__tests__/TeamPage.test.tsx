// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/hooks/useTeam', () => ({
  useTeamSummary: vi.fn(),
  useInviteMember: vi.fn(),
  useUpdateMemberRole: vi.fn(),
  useRemoveMember: vi.fn(),
}));

import { TeamPage } from '../TeamPage';
import {
  useTeamSummary,
  useInviteMember,
  useUpdateMemberRole,
  useRemoveMember,
} from '@/hooks/useTeam';

const summary = {
  tenantId: 'tenant-1',
  plan: 'team',
  seatLimit: 10,
  activeSeats: 2,
  pendingSeats: 1,
  members: [
    {
      userId: 'owner@example.com',
      role: 'admin',
      status: 'active',
      invitedAt: '2026-08-01T00:00:00Z',
      joinedAt: '2026-08-01T00:00:00Z',
    },
    {
      userId: 'invitee@example.com',
      role: 'member',
      status: 'pending',
      invitedAt: '2026-08-02T00:00:00Z',
      joinedAt: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTeamSummary).mockReturnValue({ data: summary, isLoading: false } as never);
  vi.mocked(useInviteMember).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useUpdateMemberRole).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useRemoveMember).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
});

describe('TeamPage', () => {
  it('renders the seat summary and members', async () => {
    render(<TeamPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Team')).toBeInTheDocument());
    expect(screen.getByText('team')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('invitee@example.com')).toBeInTheDocument();
  });

  it('invites a member with the selected role', async () => {
    const mutate = vi.fn();
    vi.mocked(useInviteMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.type(screen.getByPlaceholderText('user@example.com'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'admin' }));
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(mutate).toHaveBeenCalledWith(
      { userId: 'new@example.com', role: 'admin' },
      expect.any(Object),
    );
  });

  it('removes a member', async () => {
    const mutate = vi.fn();
    vi.mocked(useRemoveMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(mutate).toHaveBeenCalledWith('owner@example.com');
  });
});
