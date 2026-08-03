// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '../Layout.js';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => themeState,
}));

const { authState, themeState } = vi.hoisted(() => ({
  authState: { isAuthenticated: true, isLoading: false, logout: vi.fn(), login: vi.fn() },
  themeState: { theme: 'dark', toggleTheme: vi.fn() },
}));

function renderLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<div>Home content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.isAuthenticated = true;
  authState.isLoading = false;
  themeState.theme = 'dark';
  vi.clearAllMocks();
});

const NAV_LABELS = [
  'Dashboard',
  'Candidates',
  'Runs',
  'Score',
  'Portfolio',
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
