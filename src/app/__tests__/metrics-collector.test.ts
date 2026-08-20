// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../metrics-collector.js';

describe('MetricsCollector DNS consensus (ADR-0039)', () => {
  it('records and accumulates consensus verdict tallies', () => {
    const collector = new MetricsCollector();
    collector.recordDnsConsensus({ verified: 3, disagreed: 1, unverifiable: 2, degraded: false });
    collector.recordDnsConsensus({
      verified: 4,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
      tertiaryRescued: 3,
    });

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(true);
    expect(consensus.verifiedTotal).toBe(7);
    expect(consensus.disagreedTotal).toBe(1);
    expect(consensus.unverifiableTotal).toBe(2);
    expect(consensus.degradedRunsTotal).toBe(0);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('accumulates tertiary-rescue tallies (ADR-0045)', () => {
    const collector = new MetricsCollector();
    collector.recordDnsConsensus({ verified: 2, disagreed: 0, unverifiable: 1, degraded: false });
    collector.recordDnsConsensus({
      verified: 1,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
      tertiaryRescued: 1,
    });

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.tertiaryRescuedTotal).toBe(1);
  });

  it('reports observed=false before any consensus run', () => {
    const collector = new MetricsCollector();
    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.tertiaryRescuedTotal).toBe(0);
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
    collector.recordDnsConsensus({
      verified: 1,
      disagreed: 0,
      unverifiable: 1,
      degraded: true,
      tertiaryRescued: 2,
    });
    collector.reset();

    const consensus = collector.snapshot().pipeline.dnsConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.tertiaryRescuedTotal).toBe(0);
    expect(consensus.degradedRunsTotal).toBe(0);
  });
});

describe('MetricsCollector RDAP consensus + bootstrap (ADR-0058)', () => {
  it('records and accumulates RDAP consensus verdict tallies', () => {
    const collector = new MetricsCollector();
    collector.recordRdapConsensus({ verified: 3, disagreed: 1, unverifiable: 2, degraded: false });
    collector.recordRdapConsensus({
      verified: 4,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
      whoisRescued: 2,
      originOverlap: 1,
      originGuardUnavailable: 2,
    });

    const consensus = collector.snapshot().pipeline.rdapConsensus!;
    expect(consensus.observed).toBe(true);
    expect(consensus.verifiedTotal).toBe(7);
    expect(consensus.disagreedTotal).toBe(1);
    expect(consensus.unverifiableTotal).toBe(2);
    expect(consensus.whoisRescuedTotal).toBe(2);
    expect(consensus.originOverlapTotal).toBe(1);
    expect(consensus.originGuardUnavailableTotal).toBe(2);
    expect(consensus.degradedRunsTotal).toBe(0);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('reports observed=false before any RDAP consensus run', () => {
    const collector = new MetricsCollector();
    const consensus = collector.snapshot().pipeline.rdapConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.whoisRescuedTotal).toBe(0);
    expect(consensus.originOverlapTotal).toBe(0);
    expect(consensus.originGuardUnavailableTotal).toBe(0);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('tracks degraded runs and the last-run degraded flag', () => {
    const collector = new MetricsCollector();
    collector.recordRdapConsensus({ verified: 1, disagreed: 0, unverifiable: 5, degraded: true });
    collector.recordRdapConsensus({ verified: 2, disagreed: 0, unverifiable: 0, degraded: false });

    const consensus = collector.snapshot().pipeline.rdapConsensus!;
    expect(consensus.degradedRunsTotal).toBe(1);
    expect(consensus.lastRunDegraded).toBe(false);
  });

  it('records the latest bootstrap status', () => {
    const collector = new MetricsCollector();
    collector.recordRdapBootstrap({
      ok: false,
      consecutiveFailures: 2,
      lastSuccessAtMs: 1_700_000_000_000,
      nextRetryAtMs: 1_700_000_300_000,
    });

    const bootstrap = collector.snapshot().rdapBootstrap!;
    expect(bootstrap.observed).toBe(true);
    expect(bootstrap.ok).toBe(false);
    expect(bootstrap.consecutiveFailures).toBe(2);
    expect(bootstrap.lastSuccessAtMs).toBe(1_700_000_000_000);
    expect(bootstrap.nextRetryAtMs).toBe(1_700_000_300_000);
  });

  it('reports observed=false before any bootstrap status', () => {
    const collector = new MetricsCollector();
    const bootstrap = collector.snapshot().rdapBootstrap!;
    expect(bootstrap.observed).toBe(false);
    expect(bootstrap.ok).toBeNull();
  });

  it('reset clears RDAP consensus and bootstrap tallies', () => {
    const collector = new MetricsCollector();
    collector.recordRdapConsensus({ verified: 1, disagreed: 0, unverifiable: 1, degraded: true });
    collector.recordRdapBootstrap({
      ok: true,
      consecutiveFailures: 0,
      lastSuccessAtMs: 1,
      nextRetryAtMs: null,
    });
    collector.reset();

    const consensus = collector.snapshot().pipeline.rdapConsensus!;
    expect(consensus.observed).toBe(false);
    expect(consensus.verifiedTotal).toBe(0);
    expect(consensus.whoisRescuedTotal).toBe(0);
    expect(collector.snapshot().rdapBootstrap!.observed).toBe(false);
  });
});

describe('MetricsCollector trademark gate', () => {
  it('records and accumulates verdict tallies', () => {
    const collector = new MetricsCollector();
    collector.recordTrademarkGate({ verdict: 'clear', usptoOk: true, euipoOk: true });
    collector.recordTrademarkGate({ verdict: 'blocked', usptoOk: true, euipoOk: true });
    collector.recordTrademarkGate({
      verdict: 'unverified',
      usptoOk: false,
      euipoOk: false,
    });

    const tm = collector.snapshot().pipeline.trademarkGate!;
    expect(tm.observed).toBe(true);
    expect(tm.clearTotal).toBe(1);
    expect(tm.blockedTotal).toBe(1);
    expect(tm.unverifiedTotal).toBe(1);
    expect(tm.partialTotal).toBe(0);
    expect(tm.usptoFailuresTotal).toBe(1);
    expect(tm.euipoFailuresTotal).toBe(1);
  });

  it('counts partial clear verdicts separately', () => {
    const collector = new MetricsCollector();
    collector.recordTrademarkGate({
      verdict: 'clear',
      partial: true,
      usptoOk: true,
      euipoOk: false,
    });
    collector.recordTrademarkGate({ verdict: 'clear', usptoOk: true, euipoOk: true });

    const tm = collector.snapshot().pipeline.trademarkGate!;
    expect(tm.clearTotal).toBe(2);
    expect(tm.partialTotal).toBe(1);
    expect(tm.euipoFailuresTotal).toBe(1);
  });

  it('reports observed=false before any gate check', () => {
    const collector = new MetricsCollector();
    const tm = collector.snapshot().pipeline.trademarkGate!;
    expect(tm.observed).toBe(false);
    expect(tm.clearTotal).toBe(0);
    expect(tm.unverifiedTotal).toBe(0);
  });

  it('reset clears trademark gate tallies', () => {
    const collector = new MetricsCollector();
    collector.recordTrademarkGate({
      verdict: 'clear',
      partial: true,
      usptoOk: false,
      euipoOk: true,
    });
    collector.recordTrademarkGate({ verdict: 'unverified', usptoOk: false, euipoOk: false });
    collector.reset();

    const tm = collector.snapshot().pipeline.trademarkGate!;
    expect(tm.observed).toBe(false);
    expect(tm.clearTotal).toBe(0);
    expect(tm.partialTotal).toBe(0);
    expect(tm.usptoFailuresTotal).toBe(0);
  });
});

describe('MetricsCollector anonymous trademark budget (ADR-0056)', () => {
  it('records and accumulates budget grants and fail-open blocks', () => {
    const collector = new MetricsCollector();
    collector.recordAnonTrademarkBudget(true);
    collector.recordAnonTrademarkBudget(true);
    collector.recordAnonTrademarkBudget(false);

    const anon = collector.snapshot().anonTrademark!;
    expect(anon.observed).toBe(true);
    expect(anon.hitsTotal).toBe(2);
    expect(anon.blockedTotal).toBe(1);
  });

  it('reports observed=false before any anonymous budget outcome', () => {
    const collector = new MetricsCollector();
    const anon = collector.snapshot().anonTrademark!;
    expect(anon.observed).toBe(false);
    expect(anon.hitsTotal).toBe(0);
    expect(anon.blockedTotal).toBe(0);
  });

  it('reset clears anonymous budget tallies', () => {
    const collector = new MetricsCollector();
    collector.recordAnonTrademarkBudget(false);
    collector.reset();

    const anon = collector.snapshot().anonTrademark!;
    expect(anon.observed).toBe(false);
    expect(anon.blockedTotal).toBe(0);
    expect(anon.hitsTotal).toBe(0);
  });
});

describe('MetricsCollector latency histograms (ADR-0064)', () => {
  it('records observations into cumulative buckets and sums', () => {
    const collector = new MetricsCollector();
    collector.recordHistogram('dominus_dns_leg_duration_ms', 10, {
      transport: 'doh',
      endpoint: 'doh:cloudflare-dns.com',
      verdict: 'available',
      role: 'primary',
    });
    collector.recordHistogram('dominus_dns_leg_duration_ms', 5000, {
      transport: 'doh',
      endpoint: 'doh:cloudflare-dns.com',
      verdict: 'available',
      role: 'primary',
    });

    const hist = Object.values(collector.snapshot().histograms ?? {})[0]!;
    expect(hist.name).toBe('dominus_dns_leg_duration_ms');
    expect(hist.count).toBe(2);
    expect(hist.sum).toBe(5010);
    // 10ms falls in the first bucket and every later one; 5000ms stops at the
    // 5000 bucket. 30000 is the largest fixed bucket.
    const idx5000 = hist.bucketsMs.indexOf(5000);
    const idx30000 = hist.bucketsMs.indexOf(30000);
    expect(hist.bucketCounts[idx5000]).toBe(2);
    expect(hist.bucketCounts[idx30000]).toBe(2);
    const idx2500 = hist.bucketsMs.indexOf(2500);
    expect(hist.bucketCounts[idx2500]).toBe(1);
  });

  it('drops negative and non-finite samples', () => {
    const collector = new MetricsCollector();
    collector.recordHistogram('h', -1, {});
    collector.recordHistogram('h', Number.NaN, {});
    collector.recordHistogram('h', Infinity, {});

    expect(Object.values(collector.snapshot().histograms ?? {})).toHaveLength(0);
  });

  it('keeps label sets apart and preserves the labels in the snapshot', () => {
    const collector = new MetricsCollector();
    collector.recordHistogram('h', 10, { role: 'consensus', transport: 'dot' });
    collector.recordHistogram('h', 10, { role: 'primary', transport: 'doh' });

    const histograms = collector.snapshot().histograms ?? {};
    const samples = Object.values(histograms);
    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.bucketsMs.length > 0)).toBe(true);
    expect(samples.some((s) => s.labels.role === 'consensus')).toBe(true);
    expect(samples.some((s) => s.labels.role === 'primary')).toBe(true);
  });

  it('reset clears histograms', () => {
    const collector = new MetricsCollector();
    collector.recordHistogram('h', 10, { role: 'primary' });
    collector.reset();

    expect(Object.values(collector.snapshot().histograms ?? {})).toHaveLength(0);
  });
});
