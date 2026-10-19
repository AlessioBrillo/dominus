// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/registrar-catalog', () => ({
  getTlds: vi.fn(),
  getRegistrars: vi.fn(),
  getTldMatrix: vi.fn(),
  computeTco: vi.fn(),
  recommendRegistrar: vi.fn(),
}));

import { RegistrarCatalogPage } from '../RegistrarCatalogPage';
import { getTlds, getRegistrars, getTldMatrix } from '@/api/registrar-catalog';

const tlds = ['com', 'io', 'app'];
const registrars = [
  {
    name: 'Cloudflare',
    tlds: ['com', 'io', 'app'],
    note: 'No markup on registry pricing',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTlds).mockResolvedValue({ tlds });
  vi.mocked(getRegistrars).mockResolvedValue({ registrars });
  vi.mocked(getTldMatrix).mockResolvedValue({
    matrix: {
      tld: 'com',
      prices: [
        {
          registrar: 'Cloudflare',
          register: 9.0,
          renew: 9.0,
          transfer: 9.0,
          currency: 'EUR',
        },
      ],
      cheapestRegistrar: 'Cloudflare',
      cheapestPrice: 9.0,
    },
  });
});

describe('RegistrarCatalogPage', () => {
  it('renders the title and registrars table', async () => {
    render(<RegistrarCatalogPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Registrar catalog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh registrars' })).toBeInTheDocument();
    expect(screen.getByRole('combobox') ?? screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows empty state when no registrars', async () => {
    vi.mocked(getRegistrars).mockResolvedValue({ registrars: [] });
    render(<RegistrarCatalogPage />, { wrapper: createWrapper() });

    await screen.findByText('No registrar data');
  });
});
