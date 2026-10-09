// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/api/client';

vi.mock('@/api/team', () => ({ acceptInvitation: vi.fn() }));

import { InvitePage } from '../InvitePage';
import { acceptInvitation } from '@/api/team';
import { rememberInvite, takeInvite } from '@/lib/pending-invite';

const TOKEN = 'a'.repeat(43);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/invite/${TOKEN}`]}>
        <Routes>
          <Route path="/invite/:token" element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('InvitePage', () => {
  it('redeems the token from the URL and confirms the join', async () => {
    vi.mocked(acceptInvitation).mockResolvedValue({ tenantId: 't', role: 'member' });
    rememberInvite(TOKEN);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByText('You are in')).toBeVisible();
    expect(takeInvite()).toBeNull(); // parked token cleared
  });

  it('explains an invalid or used link and stops the redirect loop', async () => {
    vi.mocked(acceptInvitation).mockRejectedValue(new ApiError(400, 'INVITATION_INVALID', 'x'));
    rememberInvite(TOKEN);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid, expired or has already/i);
    expect(takeInvite()).toBeNull();
  });

  it('tells API-key users that SSO is required', async () => {
    vi.mocked(acceptInvitation).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x'));
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/single sign-on/i);
  });

  it('explains an email mismatch', async () => {
    vi.mocked(acceptInvitation).mockRejectedValue(
      new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'x'),
    );
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/different email address/i);
  });

  it('reports a full team', async () => {
    vi.mocked(acceptInvitation).mockRejectedValue(new ApiError(409, 'SEAT_LIMIT_EXCEEDED', 'x'));
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no free seat/i);
  });
});
