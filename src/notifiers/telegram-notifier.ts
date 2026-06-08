import { NotifierChannel } from './notifier.js';
import type { Notifier } from './notifier.js';
import type { RenewalAlert } from '../types/alert.js';

export interface TelegramNotifierConfig {
  botToken: string;
  chatId: string;
}

export class TelegramNotifier implements Notifier {
  readonly channel: NotifierChannel = 'telegram';

  constructor(private readonly config: TelegramNotifierConfig) {}

  async send(alert: RenewalAlert): Promise<void> {
    const emoji = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🟢';
    const text =
      `${emoji} *DOMINUS Alert* — ${alert.alertType}\n` +
      `Domain: \`${alert.domain}\`\n` +
      `Severity: ${alert.severity}\n` +
      `Message: ${alert.message}` +
      (alert.details ? `\nDetails: ${alert.details}` : '');

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        process.stderr.write(`Telegram API error: ${response.status} ${body}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `Telegram notification failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
