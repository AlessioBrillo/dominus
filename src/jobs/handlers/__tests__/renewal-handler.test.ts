/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { RenewalCheckHandler } from '../renewal-handler.js';

describe('RenewalCheckHandler', () => {
  it('calls alertEngine.checkAll and formats the result', async () => {
    const alertEngine = {
      checkAll: vi.fn().mockResolvedValue({
        generated: 3,
        alerts: [{ domain: 'example.com' }, { domain: 'test.com' }, { domain: 'demo.com' }],
      }),
    };
    const handler = new RenewalCheckHandler({ alertEngine } as any);

    const result = await handler.handle({});

    expect(alertEngine.checkAll).toHaveBeenCalled();
    expect(result.alertsCreated).toBe(3);
    expect(result.alertsAcknowledged).toBe(0);
    expect(result.domainsChecked).toBe(3);
  });

  it('handles empty alerts', async () => {
    const alertEngine = {
      checkAll: vi.fn().mockResolvedValue({ generated: 0, alerts: [] }),
    };
    const handler = new RenewalCheckHandler({ alertEngine } as any);

    const result = await handler.handle({});

    expect(result.alertsCreated).toBe(0);
    expect(result.domainsChecked).toBe(0);
  });

  it('has the correct jobType', () => {
    const handler = new RenewalCheckHandler({ alertEngine: {} } as any);
    expect(handler.jobType).toBe('RENEWAL_CHECK');
  });
});
