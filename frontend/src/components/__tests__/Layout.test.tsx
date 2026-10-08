// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '../Layout.js';
import { takeInvite } from '@/lib/pending-invite';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/hooks/useMe', () => ({
  useMe: () => meState,
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => themeState,
}));

const { authState, themeState, meState } = vi.hoisted(() => ({
  meState: { isOperator: false },
  authState: { isAuthenticated: true, isLoading: false, logout: vi.fn(), login: vi.fn() },
  themeState: { theme: 'dark', toggleTheme: vi.fn() },
}));

function renderLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<div>Home content</div>} />
          <Route path="invite/:token" element={<div>Invite content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.isAuthenticated = true;
  authState.isLoading = false;
  themeState.theme = 'dark';
  meState.isOperator = false;
  vi.clearAllMocks();
});

const NAV_LABELS = [
  'Dashboard',
  'Candidates',
  'Runs',
  'Score',
  'Portfolio',
  'Buy',
  'Listings',
  'Bids',
  'Outcomes',
  'Watchlist',
  'Backtest',
  'Analytics',
  'Scheduler',
  'Providers',
  'Billing',
  'Settings',
];

describe('Layout', () => {
  it('shows a loading screen while auth is loading', () => {
    authState.isLoading = true;
    renderLayout();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders the login form when unauthenticated', () => {
    authState.isAuthenticated = false;
    renderLayout();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('renders navigation items, content and theme label when authenticated', () => {
    renderLayout();
    for (const label of NAV_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Home content')).toBeInTheDocument();
    expect(screen.getByText('Light Mode')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  describe('invitation links', () => {
    const TOKEN = 'b'.repeat(43);

    it('remembers the token while signed out, then routes there after sign-in', () => {
      authState.isAuthenticated = false;
      const { unmount } = renderLayout(`/invite/${TOKEN}`);
      unmount();

      authState.isAuthenticated = true;
      renderLayout('/');
      expect(screen.getByText('Invite content')).toBeInTheDocument();
      expect(takeInvite()).toBeNull(); // consumed exactly once
    });

    it('lets a signed-in user leave the invite page (no redirect trap)', () => {
      authState.isAuthenticated = true;
      sessionStorage.clear();
      renderLayout(`/invite/${TOKEN}`);
      expect(takeInvite()).toBeNull(); // nothing re-parked while signed in
    });

    it('does not redirect when no invitation is pending', () => {
      sessionStorage.clear();
      renderLayout('/');
      expect(screen.getByText('Home content')).toBeInTheDocument();
    });
  });

  it('hides the cross-tenant Admin link from regular users', () => {
    renderLayout();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows the Admin link to platform operators', () => {
    meState.isOperator = true;
    renderLayout();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('renders dark mode label when the theme is dark', () => {
    renderLayout();
    expect(screen.getByText('Light Mode')).toBeInTheDocument();
  });

  it('renders light theme label and theme toggle action', () => {
    themeState.theme = 'light';
    renderLayout();
    expect(screen.getByText('Dark Mode')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dark Mode'));
    expect(themeState.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('collapses the sidebar when the menu toggle is clicked', () => {
    const { container } = renderLayout();
    const aside = container.querySelector('aside') as HTMLElement | null;
    expect(aside).not.toBeNull();
    expect(within(aside!).getByText('Logout')).toBeInTheDocument();

    fireEvent.click(within(aside!).getAllByRole('button')[0]!);

    expect(within(aside!).queryByText('Logout')).not.toBeInTheDocument();
    expect(within(aside!).queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('logs out and navigates home', () => {
    renderLayout();
    fireEvent.click(screen.getByText('Logout'));
    expect(authState.logout).toHaveBeenCalledTimes(1);
  });
});
