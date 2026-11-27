// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const logout = vi.fn();

vi.mock('@/api/mobile', () => ({
  listDevices: vi.fn(),
  fetchPushStatus: vi.fn(),
  createDevice: vi.fn(),
  revokeDevice: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  IS_STORE_BUILD: false,
  storeDeviceToken: vi.fn(),
  getStoredDeviceToken: vi.fn(() => null),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ logout }) }));
vi.mock('@/components/DataRightsCard', () => ({
  DataRightsCard: () => <div>Your data</div>,
}));

import { AccountPage } from '../AccountPage';
import {
  createDevice,
  fetchPushStatus,
  listDevices,
  revokeDevice,
  subscribePush,
  unsubscribePush,
} from '@/api/mobile';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const device = { id: 1, label: 'Phone', createdAt: '2026-11-27T00:00:00Z' };
const subscription = {
  id: 7,
  platform: 'web' as const,
  topics: { renewal: true, watchlist: false, verdict: true },
  createdAt: '2026-11-27T00:00:00Z',
};

describe('AccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listDevices).mockResolvedValue({ devices: [device] });
    vi.mocked(fetchPushStatus).mockResolvedValue({
      enabled: false,
      vapidPublicKey: null,
      subscriptions: [],
    });
    vi.mocked(createDevice).mockResolvedValue({
      token: 'dominus_device_abc',
      device: { ...device, id: 2, label: 'This device' },
    });
    vi.mocked(revokeDevice).mockResolvedValue({ revoked: true });
    vi.mocked(subscribePush).mockResolvedValue({ subscription });
    vi.mocked(unsubscribePush).mockResolvedValue({ removed: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists devices and mints a durable token', async () => {
    render(<AccountPage />, { wrapper: createWrapper() });
    expect(await screen.findByText('Phone')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add this device/i }));
    await waitFor(() => expect(createDevice).toHaveBeenCalledWith('This device'));
    expect(await screen.findByText(/This device is signed in/i)).toBeInTheDocument();
  });

  it('revokes a device and signs out', async () => {
    render(<AccountPage />, { wrapper: createWrapper() });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith(1));
    await userEvent.click(screen.getByRole('button', { name: /Sign out/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('says push is unavailable when the server has no VAPID keys', async () => {
    render(<AccountPage />, { wrapper: createWrapper() });
    expect(await screen.findByText(/Push is not configured on this server/i)).toBeInTheDocument();
  });

  it('unsubscribes from push', async () => {
    vi.mocked(fetchPushStatus).mockResolvedValue({
      enabled: true,
      vapidPublicKey: 'key',
      subscriptions: [subscription],
    });
    render(<AccountPage />, { wrapper: createWrapper() });
    await userEvent.click(await screen.findByRole('button', { name: /Turn off/i }));
    await waitFor(() => expect(unsubscribePush).toHaveBeenCalledWith(7));
  });

  it('subscribes with the selected topics', async () => {
    const subscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({
        endpoint: 'https://push.example.net/s/1',
        keys: { p256dh: 'p', auth: 'a' },
      }),
    });
    vi.stubGlobal('PushManager', class {});
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager: { subscribe } }) },
    });
    vi.mocked(fetchPushStatus).mockResolvedValue({
      enabled: true,
      vapidPublicKey: 'BLPUBLICKEY',
      subscriptions: [],
    });

    render(<AccountPage />, { wrapper: createWrapper() });
    await userEvent.click(await screen.findByLabelText('watchlist'));
    await userEvent.click(screen.getByRole('button', { name: /Enable notifications/i }));

    await waitFor(() => expect(subscribePush).toHaveBeenCalledTimes(1));
    expect(vi.mocked(subscribePush).mock.calls[0]?.[0]).toMatchObject({
      platform: 'web',
      topics: { renewal: true, watchlist: false, verdict: true },
    });
  });
});
