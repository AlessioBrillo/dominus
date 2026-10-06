// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { DnsMonitor } from '../dns-monitor.js';

describe('DnsMonitor', () => {
  it('should track queries and calculate EWMA latency', () => {
    const monitor = new DnsMonitor();

    monitor.recordProbe({ durationMs: 100, success: true });
    monitor.recordProbe({ durationMs: 200, success: true });

    const metrics = monitor.getMetrics();
    expect(metrics.totalQueries).toBe(2);
    expect(metrics.totalErrors).toBe(0);
    expect(metrics.ewmaLatencyMs).toBeGreaterThan(100);
    expect(metrics.ewmaLatencyMs).toBeLessThan(200);
    expect(metrics.isDegraded).toBe(false);
  });

  it('should detect degradation on high latency or high error rate', () => {
    const monitor = new DnsMonitor();

    // Simulate high latency probes
    for (let i = 0; i < 10; i++) {
      monitor.recordProbe({ durationMs: 600, success: true });
    }

    const metrics = monitor.getMetrics();
    expect(metrics.isDegraded).toBe(true);
  });
});
