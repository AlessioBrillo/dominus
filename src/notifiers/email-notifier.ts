// SPDX-License-Identifier: AGPL-3.0-only
import type { Notifier, NotifierChannel } from './notifier.js';
import type { Notification } from '../types/alert.js';
import type { Mailer } from '../providers/email/mailer.js';

export interface EmailNotifierConfig {
  mailer: Mailer;
  /** Recipients of every alert on this channel. */
  to: string[];
}

export class EmailNotifier implements Notifier {
  readonly channel: NotifierChannel = 'email';

  constructor(private readonly config: EmailNotifierConfig) {}

  async send(alert: Notification): Promise<void> {
    try {
      await this.config.mailer.send({
        to: this.config.to,
        subject: `[DOMINUS ${alert.severity}] ${alert.domain}: ${alert.alertType}`,
        text: [alert.message, alert.details ?? '', `Time: ${alert.createdAt ?? ''}`]
          .filter((line) => line !== '')
          .join('\n\n'),
      });
    } catch (err) {
      // Like the other notifiers: a delivery failure must never break the run.
      process.stderr.write(
        `Email failed for ${alert.domain}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
