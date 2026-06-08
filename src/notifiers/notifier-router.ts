import type { Notifier } from './notifier.js';
import { ConsoleNotifier } from './console-notifier.js';
import { DesktopNotifier } from './desktop-notifier.js';
import { WebhookNotifier } from './webhook-notifier.js';
import { TelegramNotifier } from './telegram-notifier.js';
import type { Config } from '../config.js';

export function buildNotifiers(config: Config): Notifier[] {
  const notifiers: Notifier[] = [];

  notifiers.push(new ConsoleNotifier());

  if (config.NOTIFIER_DESKTOP_ENABLED) {
    notifiers.push(new DesktopNotifier());
  }

  if (config.NOTIFIER_WEBHOOK_URL) {
    notifiers.push(new WebhookNotifier({ url: config.NOTIFIER_WEBHOOK_URL }));
  }

  if (config.NOTIFIER_TELEGRAM_BOT_TOKEN && config.NOTIFIER_TELEGRAM_CHAT_ID) {
    notifiers.push(
      new TelegramNotifier({
        botToken: config.NOTIFIER_TELEGRAM_BOT_TOKEN,
        chatId: config.NOTIFIER_TELEGRAM_CHAT_ID,
      }),
    );
  }

  return notifiers;
}

export async function sendAlert(
  notifiers: Notifier[],
  alert: Parameters<Notifier['send']>[0],
): Promise<string[]> {
  const channels: string[] = [];
  for (const notifier of notifiers) {
    try {
      await notifier.send(alert);
      channels.push(notifier.channel);
    } catch {
      // individual notifier failures are handled inside each notifier
    }
  }
  return channels;
}
