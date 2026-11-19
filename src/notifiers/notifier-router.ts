// SPDX-License-Identifier: AGPL-3.0-only
import type { Notifier, NotifierChannel } from './notifier.js';
import { ConsoleNotifier } from './console-notifier.js';
import { DesktopNotifier } from './desktop-notifier.js';
import { WebhookNotifier } from './webhook-notifier.js';
import { TelegramNotifier } from './telegram-notifier.js';
import { EmailNotifier } from './email-notifier.js';
import { createMailer } from '../providers/email/index.js';
import type { Config } from '../config.js';
import type { TenantNotificationService } from '../services/tenant-notification-service.js';
import { getTenantId } from '../utils/tenant-context.js';
import { AlertType, AlertSeverity } from '../types/alert.js';

/**
 * A notifier that resolves its channels per call.
 *
 * The plain `Notifier` contract reports ONE channel; the tenant router
 * resolves the channels of the tenant the alert belongs to, and the alert
 * row must record the channels that were really used.
 */
export interface MultiChannelNotifier extends Notifier {
  /** The channels that were used for this alert. */
  sendDetailed(alert: Parameters<Notifier['send']>[0]): Promise<NotifierChannel[]>;
}

function isMultiChannel(notifier: Notifier): notifier is MultiChannelNotifier {
  return typeof (notifier as MultiChannelNotifier).sendDetailed === 'function';
}

/**
 * The channels of the OPERATOR: the webhook, the Telegram chat and the
 * mailbox of the person who runs the installation.
 */
function buildOperatorChannels(config: Config): Notifier[] {
  const channels: Notifier[] = [];

  if (config.NOTIFIER_DESKTOP_ENABLED) {
    channels.push(new DesktopNotifier());
  }

  if (config.NOTIFIER_WEBHOOK_URL) {
    channels.push(new WebhookNotifier({ url: config.NOTIFIER_WEBHOOK_URL }));
  }

  if (config.NOTIFIER_TELEGRAM_BOT_TOKEN && config.NOTIFIER_TELEGRAM_CHAT_ID) {
    channels.push(
      new TelegramNotifier({
        botToken: config.NOTIFIER_TELEGRAM_BOT_TOKEN,
        chatId: config.NOTIFIER_TELEGRAM_CHAT_ID,
      }),
    );
  }

  const mailer = createMailer(config);
  const emailTo = (config.NOTIFIER_EMAIL_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (mailer.configured && emailTo.length > 0) {
    channels.push(new EmailNotifier({ mailer, to: emailTo }));
  }

  return channels;
}

/**
 * Routes an alert to the tenant it belongs to.
 *
 * With a tenant context (an API request, a worker job, a per-tenant
 * scheduled job) the alert goes to THAT tenant's channels and to nobody
 * else: the operator channels are the operator's business, and a customer's
 * domain names must not end up in somebody else's Telegram chat.
 *
 * Without a tenant context (a platform-level alert) the operator channels
 * are used, exactly as before.
 */
export class TenantScopedNotifier implements MultiChannelNotifier {
  readonly channel: NotifierChannel = 'console';

  constructor(
    private readonly consoleNotifier: Notifier,
    private readonly operatorChannels: Notifier[],
    private readonly tenantService: TenantNotificationService,
  ) {}

  async send(alert: Parameters<Notifier['send']>[0]): Promise<void> {
    await this.sendDetailed(alert);
  }

  async sendDetailed(alert: Parameters<Notifier['send']>[0]): Promise<NotifierChannel[]> {
    const channels: NotifierChannel[] = [];

    // The console is the server log: it is written for the operator and it
    // stays in the server log, whatever the tenant scope is.
    await this.consoleNotifier.send(alert);
    channels.push(this.consoleNotifier.channel);

    const tenantId = getTenantId();
    if (tenantId) {
      channels.push(...(await this.tenantService.sendToTenant(tenantId, alert)));
      return channels;
    }

    for (const notifier of this.operatorChannels) {
      try {
        await notifier.send(alert);
        channels.push(notifier.channel);
      } catch {
        // individual notifier failures are handled inside each notifier
      }
    }
    return channels;
  }
}

/**
 * The notifier chain of the application.
 *
 * With a tenant notification service the chain is tenant-scoped: the alerts
 * of a tenant go to that tenant. Without it (the community edition, a
 * single-tenant installation) the chain is the operator's, as before.
 */
export function buildNotifiers(
  config: Config,
  tenantService?: TenantNotificationService,
): Notifier[] {
  const consoleNotifier = new ConsoleNotifier();
  const operatorChannels = buildOperatorChannels(config);

  if (!tenantService) {
    return [consoleNotifier, ...operatorChannels];
  }

  return [new TenantScopedNotifier(consoleNotifier, operatorChannels, tenantService)];
}

export async function sendAlert(
  notifiers: Notifier[],
  alert: Parameters<Notifier['send']>[0],
): Promise<string[]> {
  const channels: string[] = [];
  for (const notifier of notifiers) {
    try {
      if (isMultiChannel(notifier)) {
        channels.push(...(await notifier.sendDetailed(alert)));
        continue;
      }
      await notifier.send(alert);
      channels.push(notifier.channel);
    } catch {
      // individual notifier failures are handled inside each notifier
    }
  }
  return channels;
}

/**
 * Send a system-level alert (non-domain-specific) through the notifier chain.
 * Uses 'system' as the domain placeholder to fit the existing Notification
 * interface without adding a new type.
 */
export async function sendSystemAlert(
  notifiers: Notifier[],
  message: string,
  details?: string,
): Promise<string[]> {
  return sendAlert(notifiers, {
    domain: 'system',
    alertType: AlertType.SystemError,
    severity: AlertSeverity.Critical,
    message,
    details,
    createdAt: new Date().toISOString(),
  } as Parameters<Notifier['send']>[0]);
}
