// SPDX-License-Identifier: AGPL-3.0-only
import type { TenantNotificationSettingsRepository } from '../db/repositories/tenant-notification-settings-repository.js';
import type { Mailer } from '../providers/email/mailer.js';
import type { SecretBox } from '../utils/secret-box.js';
import type { Notifier, NotifierChannel } from '../notifiers/notifier.js';
import { EmailNotifier } from '../notifiers/email-notifier.js';
import { WebhookNotifier } from '../notifiers/webhook-notifier.js';
import { TelegramNotifier } from '../notifiers/telegram-notifier.js';
import type { Notification } from '../types/alert.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface TenantNotificationView {
  tenantId: string;
  email: string | null;
  /** The webhook URL is never returned: it authenticates the receiver. */
  hasWebhook: boolean;
  telegramChatId: string | null;
  enabled: boolean;
}

export interface TenantNotificationServiceDeps {
  repo: TenantNotificationSettingsRepository;
  /** Encrypts/decrypts the webhook URL. Absent = no webhook can be stored. */
  secretBox?: SecretBox | undefined;
  /** The mail transport. Absent or unconfigured = no email can be sent. */
  mailer?: Mailer | undefined;
  /** The operator's Telegram bot. The tenant only chooses the chat. */
  telegramBotToken?: string | undefined;
}

export class TenantNotificationSettingsError extends Error {
  readonly code = 'NOTIFICATION_SETTINGS_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'TenantNotificationSettingsError';
  }
}

/**
 * The notification channels of a tenant.
 *
 * Until now the channels were built once from the operator's environment:
 * every alert of every tenant went to the operator, and the customer never
 * heard about the renewal of their own domain. This service reads the
 * channels of the tenant the alert belongs to, and the notifier router
 * sends the alert there instead of to the operator.
 */
export class TenantNotificationService {
  readonly #deps: TenantNotificationServiceDeps;

  constructor(deps: TenantNotificationServiceDeps) {
    this.#deps = deps;
  }

  async get(tenantId: string): Promise<TenantNotificationView> {
    const settings = await this.#deps.repo.findByTenant(tenantId);
    if (!settings) {
      return {
        tenantId,
        email: null,
        hasWebhook: false,
        telegramChatId: null,
        enabled: true,
      };
    }
    return {
      tenantId,
      email: settings.email,
      hasWebhook: settings.webhookUrlEncrypted !== null,
      telegramChatId: settings.telegramChatId,
      enabled: settings.enabled,
    };
  }

  /**
   * Store the channels of a tenant.
   *
   * The webhook URL is encrypted: it is a bearer secret of the tenant's
   * receiver. A deployment without a master key cannot store one, and says
   * so instead of storing it in clear.
   */
  async save(
    tenantId: string,
    input: {
      email?: string | null | undefined;
      webhookUrl?: string | null | undefined;
      telegramChatId?: string | null | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<TenantNotificationView> {
    const current = await this.#deps.repo.findByTenant(tenantId);

    let webhookUrlEncrypted = current?.webhookUrlEncrypted ?? null;
    if (input.webhookUrl !== undefined) {
      if (input.webhookUrl === null || input.webhookUrl === '') {
        webhookUrlEncrypted = null;
      } else {
        if (!this.#deps.secretBox) {
          throw new TenantNotificationSettingsError(
            'A webhook URL cannot be stored: the vault is not configured (set VAULT_ENCRYPTION_KEY)',
          );
        }
        const parsed = new URL(input.webhookUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new TenantNotificationSettingsError('The webhook URL must be an http(s) URL');
        }
        webhookUrlEncrypted = this.#deps.secretBox.encrypt(input.webhookUrl);
      }
    }

    await this.#deps.repo.save({
      tenantId,
      email: input.email === undefined ? (current?.email ?? null) : input.email,
      webhookUrlEncrypted,
      telegramChatId:
        input.telegramChatId === undefined
          ? (current?.telegramChatId ?? null)
          : input.telegramChatId,
      enabled: input.enabled ?? current?.enabled ?? true,
    });

    return this.get(tenantId);
  }

  /** Delete the channels of a tenant (the alerts go nowhere afterwards). */
  async clear(tenantId: string): Promise<boolean> {
    return this.#deps.repo.delete(tenantId);
  }

  /**
   * Send an alert to the channels of the tenant, and return the channels
   * that were used.
   */
  async sendToTenant(tenantId: string, alert: Notification): Promise<NotifierChannel[]> {
    const settings = await this.#deps.repo.findByTenant(tenantId);
    if (!settings || !settings.enabled) return [];

    const notifiers = this.#buildNotifiers(settings);
    const used: NotifierChannel[] = [];
    for (const notifier of notifiers) {
      try {
        await notifier.send(alert);
        used.push(notifier.channel);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), tenantId },
          'TenantNotificationService: a notification channel failed',
        );
      }
    }
    return used;
  }

  #buildNotifiers(settings: {
    email: string | null;
    webhookUrlEncrypted: string | null;
    telegramChatId: string | null;
  }): Notifier[] {
    const notifiers: Notifier[] = [];

    if (settings.email && this.#deps.mailer?.configured) {
      notifiers.push(new EmailNotifier({ mailer: this.#deps.mailer, to: [settings.email] }));
    }

    if (settings.webhookUrlEncrypted) {
      if (!this.#deps.secretBox) {
        logger.warn(
          'TenantNotificationService: the vault is not configured — the webhook channel is skipped',
        );
      } else {
        try {
          const url = this.#deps.secretBox.decrypt(settings.webhookUrlEncrypted);
          notifiers.push(new WebhookNotifier({ url }));
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'TenantNotificationService: the webhook URL could not be decrypted',
          );
        }
      }
    }

    if (settings.telegramChatId && this.#deps.telegramBotToken) {
      notifiers.push(
        new TelegramNotifier({
          botToken: this.#deps.telegramBotToken,
          chatId: settings.telegramChatId,
        }),
      );
    }

    return notifiers;
  }
}
