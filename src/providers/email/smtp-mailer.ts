// SPDX-License-Identifier: AGPL-3.0-only
import type { Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './mailer.js';

export interface SmtpMailerConfig {
  /** Connection URL, e.g. smtp://user:pass@smtp.example.com:587 or smtps://... */
  url: string;
  /** RFC 5322 From header. */
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly configured = true;
  readonly #config: SmtpMailerConfig;
  #transport: Promise<Transporter> | undefined;

  constructor(config: SmtpMailerConfig) {
    this.#config = config;
  }

  // nodemailer is loaded on first send so deployments without email never pay for it.
  #getTransport(): Promise<Transporter> {
    this.#transport ??= import('nodemailer').then(({ default: nodemailer }) =>
      nodemailer.createTransport(this.#config.url),
    );
    return this.#transport;
  }

  async send(message: MailMessage): Promise<void> {
    const transport = await this.#getTransport();
    await transport.sendMail({
      from: this.#config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
