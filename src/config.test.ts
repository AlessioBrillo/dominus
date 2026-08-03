// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from './config.js';

// Locks the schema defaults so documented and effective configuration
// cannot drift apart again (see the DNS_PARKING_CHECK_ENABLED and
// DNS_BULK_CONCURRENCY mismatches this suite was written for).
describe('config defaults', () => {
  const ENV_KEYS = [
    'DNS_PARKING_CHECK_ENABLED',
    'DNS_BULK_CONCURRENCY',
    'DNS_PERSISTENT_AVAILABLE_STALE_HOURS',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('DNS_PARKING_CHECK_ENABLED defaults to false (parking detection is opt-in)', () => {
    expect(loadConfig().DNS_PARKING_CHECK_ENABLED).toBe(false);
  });

  it('DNS_BULK_CONCURRENCY defaults to 200 (matching the documented default)', () => {
    expect(loadConfig().DNS_BULK_CONCURRENCY).toBe(200);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS defaults to 24 (availability freshness)', () => {
    expect(loadConfig().DNS_PERSISTENT_AVAILABLE_STALE_HOURS).toBe(24);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS accepts an explicit override', () => {
    process.env.DNS_PERSISTENT_AVAILABLE_STALE_HOURS = '48';
    resetConfig();
    expect(loadConfig().DNS_PERSISTENT_AVAILABLE_STALE_HOURS).toBe(48);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS rejects values below 1 hour', () => {
    process.env.DNS_PERSISTENT_AVAILABLE_STALE_HOURS = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});
