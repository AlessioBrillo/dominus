// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../config.js';

/**
 * The readiness wait for the Unbound resolver.
 *
 * The wait only changes the outcome in one of the two deployment modes, and
 * the modes want opposite defaults:
 *
 * - Cloud is strict: the resolver must be there, the app refuses to start
 *   without it, and a resolver that is still booting deserves the wait.
 * - The community edition is not strict: when the resolver is absent the
 *   Node fallback takes over (ADR-0076) and the wait only adds latency to
 *   every command. Thirty seconds of waiting for a resolver that does not
 *   exist is the difference between a first run that feels broken and one
 *   that does not.
 */
const originalEnv = { ...process.env };

function cleanCommunityEnv(): void {
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_PROVIDER;
  delete process.env.DNS_UNBOUND_READINESS_TIMEOUT_MS;
  process.env.DNS_UNBOUND_HOSTS = '127.0.0.1';
}

beforeEach(() => {
  resetConfig();
  process.env = { ...originalEnv };
});

afterEach(() => {
  resetConfig();
  process.env = { ...originalEnv };
});

describe('DNS_UNBOUND_READINESS_TIMEOUT_MS', () => {
  it('defaults to 5 seconds in the community edition', () => {
    cleanCommunityEnv();

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(false);
    expect(config.DNS_UNBOUND_READINESS_TIMEOUT_MS).toBe(5_000);
  });

  it('defaults to 30 seconds in cloud mode (DATABASE_URL set)', () => {
    cleanCommunityEnv();
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(true);
    expect(config.DNS_UNBOUND_READINESS_TIMEOUT_MS).toBe(30_000);
  });

  it('defaults to 30 seconds in cloud mode (AUTH_PROVIDER=auth0)', () => {
    cleanCommunityEnv();
    process.env.AUTH_PROVIDER = 'auth0';

    const config = loadConfig();
    expect(config.IS_CLOUD_MODE).toBe(true);
    expect(config.DNS_UNBOUND_READINESS_TIMEOUT_MS).toBe(30_000);
  });

  it('respects an explicit value in the community edition', () => {
    cleanCommunityEnv();
    process.env.DNS_UNBOUND_READINESS_TIMEOUT_MS = '12000';

    const config = loadConfig();
    expect(config.DNS_UNBOUND_READINESS_TIMEOUT_MS).toBe(12_000);
  });
});
