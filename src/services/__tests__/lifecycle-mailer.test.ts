// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { LifecycleMailer } from '../lifecycle-mailer.js';
import type { Mailer } from '../../providers/email/mailer.js';

function makeMailer(configured: boolean, fail = false): Mailer {
  return {
    configured,
    send: vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('SMTP down');
    }),
  };
}

describe('LifecycleMailer', () => {
  it('does nothing without a transport', async () => {
    const mailer = makeMailer(false);
    const lifecycle = new LifecycleMailer({
      mailer,
      ownerEmail: vi.fn(async () => 'owner@example.com'),
    });
    await lifecycle.send('payment_failed', 'tenant-1');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does nothing when no verified owner can be resolved', async () => {
    const mailer = makeMailer(true);
    const lifecycle = new LifecycleMailer({
      mailer,
      ownerEmail: vi.fn(async () => undefined),
    });
    await lifecycle.send('receipt', 'tenant-1');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('names the failure state in the subject so it is actionable', async () => {
    const mailer = makeMailer(true);
    const lifecycle = new LifecycleMailer({
      mailer,
      ownerEmail: vi.fn(async () => 'owner@example.com'),
    });
    await lifecycle.send('payment_failed', 'tenant-1');
    expect(mailer.send).toHaveBeenCalledWith({
      to: 'owner@example.com',
      subject: 'Action needed: your DOMINUS payment failed',
      text: expect.stringContaining('free plan'),
    });
  });

  it('includes the paid amount in the receipt', async () => {
    const mailer = makeMailer(true);
    const lifecycle = new LifecycleMailer({
      mailer,
      ownerEmail: vi.fn(async () => 'owner@example.com'),
    });
    await lifecycle.send('receipt', 'tenant-1', '€29.00');
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('€29.00') }),
    );
  });

  it('never fails a webhook because mail delivery failed', async () => {
    const lifecycle = new LifecycleMailer({
      mailer: makeMailer(true, true),
      ownerEmail: vi.fn(async () => 'owner@example.com'),
    });
    await expect(lifecycle.send('cancelled', 'tenant-1')).resolves.toBeUndefined();
  });

  it('never fails a webhook because owner lookup failed', async () => {
    const lifecycle = new LifecycleMailer({
      mailer: makeMailer(true),
      ownerEmail: vi.fn(async () => {
        throw new Error('db closed');
      }),
    });
    await expect(lifecycle.send('welcome', 'tenant-1')).resolves.toBeUndefined();
  });
});
