import { execFile } from 'node:child_process';
import type { Notifier, NotifierChannel } from './notifier.js';
import type { RenewalAlert } from '../types/alert.js';

export class DesktopNotifier implements Notifier {
  readonly channel: NotifierChannel = 'desktop';

  async send(alert: RenewalAlert): Promise<void> {
    const urgency = alert.severity === 'critical' ? 'critical' : alert.severity === 'warning' ? 'normal' : 'low';
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'notify-send',
          ['-u', urgency, `DOMINUS: ${alert.alertType}`, alert.message],
          { timeout: 5000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    } catch {
      // notify-send unavailable (headless, SSH, etc.) — fail silently
    }
  }
}
