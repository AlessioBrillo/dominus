// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { serverTimeoutConfig } from '../server-timeouts.js';

describe('serverTimeoutConfig', () => {
  it('keeps the keep-alive window above edge/load-balancer idle timeouts', () => {
    const { keepAliveTimeoutMs } = serverTimeoutConfig(30_000);
    expect(keepAliveTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps headersTimeout above keepAliveTimeout to avoid premature resets', () => {
    const cfg = serverTimeoutConfig(30_000);
    expect(cfg.headersTimeoutMs).toBeGreaterThan(cfg.keepAliveTimeoutMs);
  });

  it('keeps requestTimeout above the app-level request budget', () => {
    const cfg = serverTimeoutConfig(30_000);
    expect(cfg.requestTimeoutMs).toBeGreaterThan(30_000);
  });

  it('floors requestTimeout at 30s when the app-level timeout is disabled', () => {
    const cfg = serverTimeoutConfig(0);
    expect(cfg.requestTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it('keeps the same keep-alive window regardless of the request budget', () => {
    const a = serverTimeoutConfig(0);
    const b = serverTimeoutConfig(120_000);
    expect(a.keepAliveTimeoutMs).toBe(b.keepAliveTimeoutMs);
    expect(a.headersTimeoutMs).toBe(b.headersTimeoutMs);
  });
});
