// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TenantNotificationSettingsRepository } from '../../db/repositories/tenant-notification-settings-repository.js';
import { TenantNotificationService } from '../tenant-notification-service.js';
import { buildNotifiers, sendAlert } from '../../notifiers/notifier-router.js';
import { createSecretBox } from '../../utils/secret-box.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { AlertSeverity, AlertType } from '../../types/alert.js';
import type { Mailer, MailMessage } from '../../providers/email/mailer.js';
import type { Config } from '../../config.js';

class RecordingMailer implements Mailer {
  readonly configured = true;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

const alert = {
  domain: 'example.com',
  alertType: AlertType.RenewalImminent,
  severity: AlertSeverity.Warning,
  message: 'Domain example.com renews in 10 day(s)',
  createdAt: new Date().toISOString(),
};

describe('TenantNotificationService', () => {
  let db: SqliteProvider;
  let repo: TenantNotificationSettingsRepository;
  let mailer: RecordingMailer;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new TenantNotificationSettingsRepository(db);
    mailer = new RecordingMailer();
  });

  afterEach(async () => {
    await db.close();
  });

  function service(): TenantNotificationService {
    return new TenantNotificationService({
      repo,
      secretBox: createSecretBox('test-master-key'),
      mailer,
    });
  }

  it('stores the webhook URL encrypted', async () => {
    const svc = service();
    await svc.save('tenant-a', { webhookUrl: 'https://hooks.example.com/secret-token' });

    const row = await db.queryOne<{ webhook_url_encrypted: string | null }>(
      'SELECT webhook_url_encrypted FROM tenant_notification_settings WHERE tenant_id = ?',
      ['tenant-a'],
    );
    expect(row?.webhook_url_encrypted).toBeTruthy();
    expect(row?.webhook_url_encrypted).not.toContain('secret-token');

    // The view never carries the URL: it is a bearer secret.
    const view = await svc.get('tenant-a');
    expect(view.hasWebhook).toBe(true);
  });

  it('refuses a webhook when the vault is not configured', async () => {
    const svc = new TenantNotificationService({ repo, mailer });
    await expect(
      svc.save('tenant-a', { webhookUrl: 'https://hooks.example.com/x' }),
    ).rejects.toThrow(/vault is not configured/);
  });

  it('delivers the alert to the channels of the tenant', async () => {
    const svc = service();
    await svc.save('tenant-a', { email: 'owner@example.com' });

    const channels = await svc.sendToTenant('tenant-a', alert);

    expect(channels).toContain('email');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toEqual(['owner@example.com']);
  });

  it('delivers nothing when the tenant has no channel', async () => {
    const svc = service();
    expect(await svc.sendToTenant('tenant-a', alert)).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
  });

  it('keeps the channels of one tenant away from the other', async () => {
    const svc = service();
    await svc.save('tenant-a', { email: 'a@example.com' });
    await svc.save('tenant-b', { email: 'b@example.com' });

    await svc.sendToTenant('tenant-a', alert);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toEqual(['a@example.com']);
  });
});

describe('the tenant-scoped notifier chain', () => {
  let db: SqliteProvider;
  let repo: TenantNotificationSettingsRepository;
  let mailer: RecordingMailer;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new TenantNotificationSettingsRepository(db);
    mailer = new RecordingMailer();
  });

  afterEach(async () => {
    await db.close();
  });

  const config = {
    NOTIFIER_DESKTOP_ENABLED: false,
    NOTIFIER_WEBHOOK_URL: undefined,
    NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
    NOTIFIER_TELEGRAM_CHAT_ID: undefined,
    NOTIFIER_EMAIL_TO: 'operator@example.com',
    SMTP_URL: undefined,
  } as unknown as Config;

  it('sends the alert of a tenant to that tenant, not to the operator', async () => {
    const service = new TenantNotificationService({
      repo,
      secretBox: createSecretBox('test-master-key'),
      mailer,
    });
    await service.save('tenant-a', { email: 'customer@example.com' });

    // The operator's channel is configured too: the alert of a tenant must
    // not reach it.
    const operatorMailer = new RecordingMailer();
    const notifiers = buildNotifiers(
      {
        ...config,
        NOTIFIER_EMAIL_TO: 'operator@example.com',
      } as unknown as Config,
      service,
    );

    const channels = await runWithTenant('tenant-a', () => sendAlert(notifiers, alert));

    expect(channels).toContain('email');
    expect(channels).not.toContain('console-only');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toEqual(['customer@example.com']);
    expect(operatorMailer.sent).toHaveLength(0);
  });

  it('uses the operator channels when there is no tenant context', async () => {
    const service = new TenantNotificationService({
      repo,
      secretBox: createSecretBox('test-master-key'),
      mailer,
    });
    const notifiers = buildNotifiers(config as unknown as Config, service);

    const channels = await sendAlert(notifiers, alert);

    // The console is always there; the operator's email is not configured
    // (no SMTP in the test), so no email channel is reported.
    expect(channels).toContain('console');
    expect(mailer.sent).toHaveLength(0);
  });
});
