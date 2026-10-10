// SPDX-License-Identifier: AGPL-3.0-only

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
}

/**
 * Outbound email, behind an interface (ADR-0004) so SMTP can be swapped for a
 * transactional API without touching callers. Email is optional everywhere:
 * callers must work when `configured` is false.
 */
export interface Mailer {
  /** False when no transport is set up; `send` would throw. */
  readonly configured: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Used when SMTP_URL is unset (the €0 community default). */
export class NullMailer implements Mailer {
  readonly configured = false;

  async send(): Promise<void> {
    throw new Error('Email is not configured (set SMTP_URL)');
  }
}
