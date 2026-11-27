// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn().mockResolvedValue(undefined) },
}));

import webpush from 'web-push';
import { WebPushNotifier } from '../web-push-notifier.js';
import type { PushSubscriptionRepository } from '../../db/repositories/push-subscription-repository.js';
import type { PushSubscriptionRow } from '../../db/repositories/push-subscription-repository.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { Notification } from '../../types/alert.js';

function row(id: number, topics: Record<string, boolean>): PushSubscriptionRow {
  return {
    id,
    tenant_id: 'tenant-a',
    device_session_id: null,
    platform: 'web',
    endpoint: `https://push.example.net/${id}`,
    p256dh: 'key',
    auth: 'auth',
    topics_json: JSON.stringify(topics),
    expires_at: null,
    last_failure_at: null,
    created_at: '2026-11-27T00:00:00Z',
  };
}

describe('WebPushNotifier', () => {
  const findForTenant = vi.fn();
  const remove = vi.fn();
  const markFailure = vi.fn();
  const repo = { findForTenant, remove, markFailure } as unknown as PushSubscriptionRepository;
  const notifier = new WebPushNotifier(repo, {
    publicKey: 'public',
    privateKey: 'private',
    subject: 'mailto:ops@example.com',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201 } as never);
  });

  const alert: Notification = {
    domain: 'example.com',
    alertType: AlertType.RenewalImminent,
    severity: AlertSeverity.Warning,
    message: 'Renews soon',
  };

  it('only sends to subscriptions opted into the alert topic', async () => {
    findForTenant.mockResolvedValue([
      row(1, { renewal: true, watchlist: true, verdict: true }),
      row(2, { renewal: false, watchlist: true, verdict: true }),
    ]);

    await runWithTenant('tenant-a', () => notifier.send(alert));

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0]?.[0]).toMatchObject({
      endpoint: 'https://push.example.net/1',
    });
  });

  it('removes a subscription the push service says is gone', async () => {
    findForTenant.mockResolvedValue([row(3, { renewal: true, watchlist: true, verdict: true })]);
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 410 });

    await runWithTenant('tenant-a', () => notifier.send(alert));

    expect(remove).toHaveBeenCalledWith(3, 'tenant-a');
    expect(markFailure).not.toHaveBeenCalled();
  });

  it('does nothing without a tenant context', async () => {
    findForTenant.mockResolvedValue([row(4, { renewal: true, watchlist: true, verdict: true })]);
    await notifier.send(alert);
    expect(findForTenant).not.toHaveBeenCalled();
  });
});
