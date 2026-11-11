// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from '../LandingPage';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ login: vi.fn(), logout: vi.fn(), isAuthenticated: false, isLoading: false }),
}));

function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe('LandingPage', () => {
  it('says what the product does', () => {
    renderLanding();
    expect(
      screen.getByText(/A domain is worth what the evidence says it is worth/),
    ).toBeInTheDocument();
  });

  it('names the five checks of the pipeline', () => {
    renderLanding();
    expect(screen.getByText('Candidate generation')).toBeInTheDocument();
    expect(screen.getByText('DNS pre-filter')).toBeInTheDocument();
    expect(screen.getByText('RDAP confirmation')).toBeInTheDocument();
    expect(screen.getByText('Scoring')).toBeInTheDocument();
    expect(screen.getByText('Trademark gate')).toBeInTheDocument();
  });

  it('publishes the prices', () => {
    renderLanding();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('€29')).toBeInTheDocument();
    expect(screen.getByText('€79')).toBeInTheDocument();
  });

  it('offers the signup and keeps the sign-in on the same page', () => {
    renderLanding();
    const signupLinks = screen.getAllByRole('link', { name: /Create a workspace/ });
    expect(signupLinks.length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticate' })).toBeInTheDocument();
  });

  it('links the legal documents', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: 'Legal notice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument();
  });
});
