// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/api/mobile', () => ({
  listDevices: vi.fn(),
  fetchPushStatus: vi.fn(),
  createDevice: vi.fn(),
  revokeDevice: vi.fn(),
  subscribePush: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  IS_STORE_BUILD: false,
  storeDeviceToken: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ logout: vi.fn() }) }));
vi.mock('@/components/DataRightsCard', () => ({
  DataRightsCard: () => <div>Your data</div>,
}));

import { AccountPage } from '../AccountPage';
import { createDevice, fetchPushStatus, listDevices } from '@/api/mobile';
import { createWrapper } from '@/hooks/__tests__/test-utils';

describe('AccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listDevices).mockResolvedValue({
      devices: [
        {
          id: 1,
          label: 'Phone',
          createdAt: '2026-11-27T00:00:00Z',
        },
      ],
    });
    vi.mocked(fetchPushStatus).mockResolvedValue({
      enabled: false,
      vapidPublicKey: null,
      subscriptions: [],
    });
    vi.mocked(createDevice).mockResolvedValue({
      token: 'dominus_device_abc',
      device: { id: 2, label: 'This device', createdAt: '2026-11-27T00:00:00Z' },
    });
  });

  it('lists devices and mints a durable token', async () => {
    render(<AccountPage />, { wrapper: createWrapper() });
    expect(await screen.findByText('Phone')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add this device/i }));
    await waitFor(() => expect(createDevice).toHaveBeenCalledWith('This device'));
    expect(await screen.findByText(/This device is signed in/i)).toBeInTheDocument();
  });

  it('says push is unavailable when the server has no VAPID keys', async () => {
    render(<AccountPage />, { wrapper: createWrapper() });
    expect(await screen.findByText(/Push is not configured on this server/i)).toBeInTheDocument();
  });
});
