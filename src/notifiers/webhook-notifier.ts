// SPDX-License-Identifier: AGPL-3.0-only
import type { Notifier, NotifierChannel } from './notifier.js';
import type { Notification } from '../types/alert.js';

export interface WebhookNotifierConfig {
  url: string;
  /**
   * Whether an HTTP redirect is followed. The operator's webhook keeps the
   * original behaviour (follow); the webhook of a tenant does not, because
   * a public URL that answers 302 to an internal one would bypass the check
   * made when the URL was stored.
   */
  followRedirects?: boolean;
}

export class WebhookNotifier implements Notifier {
  readonly channel: NotifierChannel = 'webhook';

  constructor(private readonly config: WebhookNotifierConfig) {}

  async send(alert: Notification): Promise<void> {
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `error` refuses the redirect instead of following it.
        redirect: this.config.followRedirects === false ? 'error' : 'follow',
        body: JSON.stringify({
          event: 'notification',
          domain: alert.domain,
          alertType: alert.alertType,
          severity: alert.severity,
          message: alert.message,
          details: alert.details,
          timestamp: alert.createdAt,
        }),
      });
      if (!response.ok) {
        process.stderr.write(`Webhook returned ${response.status} for ${alert.domain}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `Webhook failed for ${alert.domain}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
