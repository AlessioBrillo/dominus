import type { Notifier, NotifierChannel } from './notifier.js';
import type { RenewalAlert } from '../types/alert.js';

export class ConsoleNotifier implements Notifier {
  readonly channel: NotifierChannel = 'console';

  async send(alert: RenewalAlert): Promise<void> {
    const severityLabel = alert.severity.toUpperCase().padEnd(8);
    const line = `[${severityLabel}] ${alert.alertType}: ${alert.message}`;
    if (alert.severity === 'critical') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}
