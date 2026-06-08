import notifier from 'node-notifier';
import type { Notifier, NotifierChannel } from './notifier.js';
import type { RenewalAlert } from '../types/alert.js';

export class DesktopNotifier implements Notifier {
  readonly channel: NotifierChannel = 'desktop';

  async send(alert: RenewalAlert): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        notifier.notify(
          {
            title: `DOMINUS: ${alert.alertType}`,
            message: alert.message,
            wait: false,
          },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    } catch {
      // Desktop notification unavailable (headless, SSH, WSL without X, etc.)
    }
  }
}
