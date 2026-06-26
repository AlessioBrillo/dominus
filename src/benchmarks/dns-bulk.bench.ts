import { bench, describe, vi } from 'vitest';
import { NodeDnsProvider } from '../providers/dns/node-dns-provider.js';

vi.mock('node:dns', () => {
  const resolve = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  return {
    promises: { resolve },
  };
});

function makeDnsProvider(): NodeDnsProvider {
  return new NodeDnsProvider({ lookupTimeoutMs: 500 });
}

describe('DNS checkAvailability (simulated)', () => {
  describe('single lookup', () => {
    bench('resolves as available', async () => {
      const provider = makeDnsProvider();
      await provider.checkAvailability('example.com');
    });
  });

  describe('bulk lookups', () => {
    bench('10 domains', async () => {
      const provider = makeDnsProvider();
      const domains = Array.from({ length: 10 }, (_, i) => `domain${i}.com`);
      const results = await provider.checkBulk(domains);
      if (results.length !== 10) {
        throw new Error('unexpected count');
      }
    });

    bench('50 domains', async () => {
      const provider = makeDnsProvider();
      const domains = Array.from({ length: 50 }, (_, i) => `domain${i}.com`);
      const results = await provider.checkBulk(domains);
      if (results.length !== 50) {
        throw new Error('unexpected count');
      }
    });

    bench('100 domains', async () => {
      const provider = makeDnsProvider();
      const domains = Array.from({ length: 100 }, (_, i) => `domain${i}.com`);
      const results = await provider.checkBulk(domains);
      if (results.length !== 100) {
        throw new Error('unexpected count');
      }
    });
  });
});
