import { describe, it, expect, vi } from 'vitest';
import { DesktopNotifier } from '../desktop-notifier.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';

vi.mock('node-notifier', () => ({
  default: {
    notify: (
      _notification: { title?: string; message?: string },
      callback: (err: Error | null) => void,
    ): void => {
      callback(null);
    },
  },
}));

describe('DesktopNotifier', () => {
  it('does not throw when notification succeeds', async () => {
    const notifier = new DesktopNotifier();
    await expect(
      notifier.send({
        domain: 'example.com',
        alertType: AlertType.RenewalImminent,
        severity: AlertSeverity.Warning,
        message: 'test',
      }),
    ).resolves.toBeUndefined();
  });
});
