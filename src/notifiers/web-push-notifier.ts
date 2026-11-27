// SPDX-License-Identifier: AGPL-3.0-only
import webpush from 'web-push';
import type { Notifier, NotifierChannel } from './notifier.js';
import type { PushSubscriptionRepository } from '../db/repositories/push-subscription-repository.js';
import type { Notification } from '../types/alert.js';
import { getTenantId } from '../utils/tenant-context.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/** Which opt-in topic an alert belongs to (ADR-0116). */
function topicFor(alertType: string): 'renewal' | 'watchlist' | 'verdict' {
  if (alertType.startsWith('renewal_')) return 'renewal';
  if (alertType === 'domain_available') return 'watchlist';
  return 'verdict';
}

export interface WebPushNotifierConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Browser push channel for the tenant that owns the alert (ADR-0116).
 *
 * The tenant is taken from AsyncLocalStorage, never from the alert: a
 * notification about a customer's domain must not be delivered to another
 * customer's devices. Subscriptions that the push service rejects as gone
 * are removed; other failures are recorded and skipped on the next send.
 */
export class WebPushNotifier implements Notifier {
  readonly channel: NotifierChannel = 'push';

  constructor(
    private readonly repo: PushSubscriptionRepository,
    private readonly config: WebPushNotifierConfig,
  ) {}

  async send(alert: Notification): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId) return;

    const topic = topicFor(alert.alertType);
    const subscriptions = (await this.repo.findForTenant(tenantId)).filter((subscription) => {
      try {
        const topics = JSON.parse(subscription.topics_json) as Record<string, boolean>;
        return topics[topic] !== false;
      } catch {
        return true; // an unreadable preference never silences an alert
      }
    });
    const payload = JSON.stringify({
      title: `DOMINUS — ${alert.domain}`,
      body: alert.message,
      url: '/alerts',
      severity: alert.severity,
      domain: alert.domain,
    });

    for (const subscription of subscriptions) {
      if (subscription.p256dh === null || subscription.auth === null) continue;
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          {
            vapidDetails: {
              subject: this.config.subject,
              publicKey: this.config.publicKey,
              privateKey: this.config.privateKey,
            },
          },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.repo.remove(subscription.id, tenantId);
        } else {
          await this.repo.markFailure(subscription.id, tenantId);
        }
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), status, tenantId },
          'WebPushNotifier: a subscription could not be delivered',
        );
      }
    }
  }
}
