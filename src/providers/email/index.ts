// SPDX-License-Identifier: AGPL-3.0-only
import type { Mailer } from './mailer.js';
import { NullMailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

export type { Mailer, MailMessage } from './mailer.js';
export { NullMailer } from './mailer.js';
export { SmtpMailer } from './smtp-mailer.js';

export function createMailer(config: { SMTP_URL?: string | undefined; SMTP_FROM: string }): Mailer {
  return config.SMTP_URL
    ? new SmtpMailer({ url: config.SMTP_URL, from: config.SMTP_FROM })
    : new NullMailer();
}
