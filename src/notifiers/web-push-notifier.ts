// SPDX-License-Identifier: AGPL-3.0-only
import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from '@block65/webcrypto-web-push';
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

/** A failed endpoint gets an hour of cooldown, not a permanent silence. */
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

/** A notification tap opens the screen that owns the decision (ADR-0116). */
function urlFor(alertType: string): string {
  if (alertType.startsWith('renewal_')) return '/portfolio';
  if (alertType === 'domain_available') return '/watchlist';
  if (alertType === 'score_dropped') return '/portfolio';
  return '/alerts';
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
 *
 * The MIT-licensed `@block65/webcrypto-web-push` builds the RFC 8291/8292
 * payload; delivery is a plain HTTPS request. No MPL dependency is added to
 * the AGPL distribution.
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
      if (
        subscription.last_failure_at !== null &&
        Date.now() - Date.parse(subscription.last_failure_at) < FAILURE_COOLDOWN_MS
      ) {
        return false;
      }
      try {
        const topics = JSON.parse(subscription.topics_json) as Record<string, boolean>;
        return topics[topic] !== false;
      } catch {
        return true; // an unreadable preference never silences an alert
      }
    });
    const data = {
      title: `DOMINUS — ${alert.domain}`,
      body: alert.message,
      url: urlFor(alert.alertType),
      severity: alert.severity,
      domain: alert.domain,
    };
    const vapid: VapidKeys = {
      subject: this.config.subject,
      publicKey: this.config.publicKey,
      privateKey: this.config.privateKey,
    };

    for (const row of subscriptions) {
      if (row.p256dh === null || row.auth === null) continue;
      const subscription: PushSubscription = {
        endpoint: row.endpoint,
        expirationTime: row.expires_at === null ? null : Date.parse(row.expires_at),
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        const payload = await buildPushPayload(
          { data, options: { ttl: 300 } },
          subscription,
          vapid,
        );
        const response = await fetch(
          row.endpoint,
          payload as unknown as Parameters<typeof fetch>[1],
        );
        if (!response.ok) {
          const err = new Error(`push service replied ${response.status}`) as Error & {
            statusCode?: number;
          };
          err.statusCode = response.status;
          throw err;
        }
        await this.repo.markSuccess(row.id, tenantId);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.repo.remove(row.id, tenantId);
        } else {
          await this.repo.markFailure(row.id, tenantId);
        }
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), status, tenantId },
          'WebPushNotifier: a subscription could not be delivered',
        );
      }
    }
  }
}
