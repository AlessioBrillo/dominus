// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';
import { ApiError } from '@/api/client';

vi.mock('@/hooks/useTeam', () => ({
  useTeamSummary: vi.fn(),
  useInviteMember: vi.fn(),
  useRevokeInvitation: vi.fn(),
  useUpdateMemberRole: vi.fn(),
  useRemoveMember: vi.fn(),
}));

import { TeamPage } from '../TeamPage';
import {
  useTeamSummary,
  useInviteMember,
  useRevokeInvitation,
  useUpdateMemberRole,
  useRemoveMember,
} from '@/hooks/useTeam';

const summary = {
  tenantId: 'tenant-1',
  plan: 'team',
  seatLimit: 10,
  activeSeats: 2,
  pendingSeats: 0,
  members: [
    {
      userId: 'owner@example.com',
      role: 'admin',
      status: 'active',
      invitedAt: '2026-08-01T00:00:00Z',
      joinedAt: '2026-08-01T00:00:00Z',
    },
    {
      userId: 'member@example.com',
      role: 'member',
      status: 'active',
      invitedAt: '2026-08-02T00:00:00Z',
      joinedAt: '2026-08-02T00:00:00Z',
    },
  ],
  invitations: [
    {
      id: 7,
      email: 'invitee@example.com',
      role: 'member',
      invitedBy: 'owner@example.com',
      expiresAt: '2026-12-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z',
    },
  ],
};

const idle = { mutate: vi.fn(), isPending: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTeamSummary).mockReturnValue({ data: summary, isLoading: false } as never);
  vi.mocked(useInviteMember).mockReturnValue(idle as never);
  vi.mocked(useRevokeInvitation).mockReturnValue(idle as never);
  vi.mocked(useUpdateMemberRole).mockReturnValue(idle as never);
  vi.mocked(useRemoveMember).mockReturnValue(idle as never);
});

describe('TeamPage', () => {
  it('renders the seat summary, members and pending invitations', async () => {
    render(<TeamPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Team')).toBeInTheDocument());
    expect(screen.getByText('team')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('invitee@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke invitation for invitee/i })).toBeVisible();
  }, 10000);

  it('invites by email with the selected role', async () => {
    const mutate = vi.fn();
    vi.mocked(useInviteMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.type(screen.getByLabelText('Email address'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'admin' }));
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(mutate).toHaveBeenCalledWith(
      { email: 'new@example.com', role: 'admin' },
      expect.any(Object),
    );
  }, 10000);

  it('shows the one-time link when email is not configured', async () => {
    const mutate = vi.fn((_input, opts) =>
      opts.onSuccess({
        invitation: { id: 9, email: 'new@example.com', role: 'member', expiresAt: 'x' },
        link: 'https://app.example.com/invite/tok123',
        emailed: false,
      }),
    );
    vi.mocked(useInviteMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.type(screen.getByLabelText('Email address'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByLabelText('Invitation link')).toHaveValue(
      'https://app.example.com/invite/tok123',
    );
    expect(screen.getByRole('status')).toHaveTextContent(/share this link yourself/i);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeVisible();
  }, 10000);

  it('explains a full plan instead of a generic failure', async () => {
    const mutate = vi.fn((_input, opts) =>
      opts.onError(new ApiError(403, 'SEAT_LIMIT_EXCEEDED', 'full')),
    );
    vi.mocked(useInviteMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.type(screen.getByLabelText('Email address'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no seats left/i);
  }, 10000);

  it('requires an email before inviting', async () => {
    const mutate = vi.fn();
    vi.mocked(useInviteMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Email is required');
  }, 10000);

  it('revokes an invitation', async () => {
    const mutate = vi.fn();
    vi.mocked(useRevokeInvitation).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.click(screen.getByRole('button', { name: /revoke invitation for invitee/i }));

    expect(mutate).toHaveBeenCalledWith(7);
  }, 10000);

  it('removes a member', async () => {
    const mutate = vi.fn();
    vi.mocked(useRemoveMember).mockReturnValue({ mutate, isPending: false } as never);
    render(<TeamPage />, { wrapper: createWrapper() });

    await userEvent.click(screen.getByRole('button', { name: 'Remove owner@example.com' }));

    expect(mutate).toHaveBeenCalledWith('owner@example.com');
  }, 10000);
});
