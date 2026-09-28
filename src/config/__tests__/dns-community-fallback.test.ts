// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../../config.js';
import { UnboundResolver } from '../../providers/dns/unbound-resolver.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  resetConfig();
  process.env = { ...originalEnv };
});

afterEach(() => {
  resetConfig();
  process.env = { ...originalEnv };
});

describe('DNS Community Edition — Unbound Mandatory (ADR-0075)', () => {
  it('should default DNS_UNBOUND_STRICT to true in community edition (no DATABASE_URL, AUTH_PROVIDER=env)', () => {
    delete process.env.DATABASE_URL;
    process.env.AUTH_PROVIDER = 'env';
    process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'true';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(false);
    expect(config.DNS_UNBOUND_STRICT).toBe(true);
  });

  it('should default DNS_UNBOUND_STRICT to true in cloud mode (DATABASE_URL set)', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.AUTH_PROVIDER = 'env';
    process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'true';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(true);
    expect(config.DNS_UNBOUND_STRICT).toBe(true);
  });

  it('should default DNS_UNBOUND_STRICT to true in cloud mode (AUTH_PROVIDER=auth0)', () => {
    delete process.env.DATABASE_URL;
    process.env.AUTH_PROVIDER = 'auth0';
    process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'true';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(true);
    expect(config.DNS_UNBOUND_STRICT).toBe(true);
  });

  it('should respect explicit DNS_UNBOUND_STRICT=true in community edition', () => {
    delete process.env.DATABASE_URL;
    process.env.AUTH_PROVIDER = 'env';
    process.env.DNS_UNBOUND_STRICT = 'true';
    process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'true';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(false);
    expect(config.DNS_UNBOUND_STRICT).toBe(true);
  });

  it('should respect explicit DNS_UNBOUND_STRICT=false in cloud mode', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.AUTH_PROVIDER = 'env';
    process.env.DNS_UNBOUND_STRICT = 'false';
    process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'false';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(true);
    expect(config.DNS_UNBOUND_STRICT).toBe(false);
  });

  it('should require DNS_UNBOUND_HOSTS and health check when DNS_UNBOUND_STRICT=true', () => {
    delete process.env.DATABASE_URL;
    process.env.AUTH_PROVIDER = 'env';
    process.env.DNS_UNBOUND_STRICT = 'true';
    // Missing DNS_UNBOUND_HOSTS and DNS_UNBOUND_HEALTH_CHECK_ENABLED
    process.env.DNS_UNBOUND_HEALTH_CHECK_ENABLED = 'false';

    expect(() => loadConfig()).toThrow(
      /DNS_UNBOUND_STRICT=true requires DNS_UNBOUND_HOSTS to be set and DNS_UNBOUND_HEALTH_CHECK_ENABLED=true/,
    );
  });
});

describe('UnboundResolver validateUnboundConfig', () => {
  it('should have validateUnboundConfig method', () => {
    const resolver = new UnboundResolver({
      unboundHosts: ['127.0.0.1'],
      lookupTimeoutMs: 1500,
      cacheTtlMs: 300000,
      maxSize: 10000,
      bulkConcurrency: 10,
      skipSocketCheck: true,
      readinessTimeoutMs: 5000,
    });

    expect(typeof resolver.validateUnboundConfig).toBe('function');

    resolver.dispose();
  });
});
