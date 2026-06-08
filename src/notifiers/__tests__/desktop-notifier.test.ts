import { describe, it, expect, vi } from 'vitest';
import { DesktopNotifier } from '../desktop-notifier.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void): void => {
    cb(null);
  },
}));

describe('DesktopNotifier', () => {
  it('does not throw when notify-send succeeds', async () => {
    const notifier = new DesktopNotifier();
    await expect(
      notifier.send({
        id: 1,
        domain: 'example.com',
        portfolioEntryId: 1,
        alertType: AlertType.RenewalImminent,
        severity: AlertSeverity.Warning,
        message: 'test',
        notifiedChannels: [],
      }),
    ).resolves.toBeUndefined();
  });
});
