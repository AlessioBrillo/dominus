// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EmailNotifier } from '../email-notifier.js';
import { buildNotifiers } from '../notifier-router.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { Notification } from '../../types/alert.js';
import type { Mailer, MailMessage } from '../../providers/email/mailer.js';
import type { Config } from '../../config.js';

const alert: Notification = {
  domain: 'example.com',
  alertType: AlertType.RenewalCritical,
  severity: AlertSeverity.Critical,
  message: 'Domain renews in 3 days',
  details: 'Renewal cost EUR 12',
};

function fakeMailer(send: (m: MailMessage) => Promise<void>): Mailer {
  return { configured: true, send };
}

describe('EmailNotifier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mails the configured recipients with the alert text', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await new EmailNotifier({ mailer: fakeMailer(send), to: ['ops@example.com'] }).send(alert);

    const msg = send.mock.calls[0]![0] as MailMessage;
    expect(msg.to).toEqual(['ops@example.com']);
    expect(msg.subject).toContain('example.com');
    expect(msg.text).toContain('Domain renews in 3 days');
    expect(msg.text).toContain('Renewal cost EUR 12');
  });

  it('never throws when delivery fails', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const send = vi.fn().mockRejectedValue(new Error('smtp down'));

    await expect(
      new EmailNotifier({ mailer: fakeMailer(send), to: ['ops@example.com'] }).send(alert),
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('smtp down'));
  });
});

describe('buildNotifiers email channel', () => {
  const base = { SMTP_FROM: 'DOMINUS <noreply@localhost>' } as unknown as Config;

  it('is off by default (no SMTP_URL)', () => {
    expect(buildNotifiers(base).map((n) => n.channel)).not.toContain('email');
  });

  it('needs both SMTP_URL and recipients', () => {
    const onlyUrl = { ...base, SMTP_URL: 'smtp://localhost:2525' } as Config;
    expect(buildNotifiers(onlyUrl).map((n) => n.channel)).not.toContain('email');

    const both = { ...onlyUrl, NOTIFIER_EMAIL_TO: 'a@example.com, b@example.com' } as Config;
    expect(buildNotifiers(both).map((n) => n.channel)).toContain('email');
  });
});
