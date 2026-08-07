// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../metrics-collector.js';

describe('MetricsCollector DNS consensus (ADR-0039)', () => {
  it('records and accumulates consensus verdict tallies', () => {
    const collector = new MetricsCollector();
    collector.recordDnsConsensus({ verified: 3, disagreed: 1, unverifiable: 2, degraded: false });
    collector.recordDnsConsensus({ verified: 4, disagreed: 0, unverifiable: 0, degraded: false });

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(true);
    expect(consensus.verifiedTotal).toBe(7);
    expect(consensus.disagreedTotal).toBe(1);
    expect(consensus.unverifiableTotal).toBe(2);
    expect(consensus.degradedRunsTotal).toBe(0);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('tracks degraded runs and the last-run degraded flag', () => {
    const collector = new MetricsCollector();
    collector.recordDnsConsensus({ verified: 1, disagreed: 0, unverifiable: 5, degraded: true });
    collector.recordDnsConsensus({ verified: 2, disagreed: 0, unverifiable: 0, degraded: false });

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.degradedRunsTotal).toBe(1);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('reports observed=false before any consensus run', () => {
    const collector = new MetricsCollector();
    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('reset clears consensus tallies', () => {
    const collector = new MetricsCollector();
    collector.recordDnsConsensus({ verified: 1, disagreed: 0, unverifiable: 1, degraded: true });
    collector.reset();

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.degradedRunsTotal).toBe(0);
  });
});
