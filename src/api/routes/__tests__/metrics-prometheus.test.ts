// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { renderPrometheusMetrics } from '../metrics.js';
import type { MetricsSnapshot } from '../../../types/metrics.js';
import type { JobQueueStats } from '../../../types/job-queue.js';

const snapshot: MetricsSnapshot = {
  pipeline: {
    totalRuns: 3,
    totalCandidatesEvaluated: 41,
    totalRecommended: 2,
    lastRunAt: '2026-08-06T00:00:00.000Z',
    lastRunDurationMs: 1200,
    stageMetrics: {
      dns: {
        stageName: 'dns',
        totalDurationMs: 100,
        totalPassed: 20,
        totalFiltered: 21,
        runCount: 3,
        lastRunAt: null,
        errorCount: 1,
      },
    },
    providerMetrics: {
      rdap: {
        providerName: 'rdap',
        totalCalls: 10,
        totalErrors: 2,
        lastCallDurationMs: 50,
        lastErrorAt: null,
        currentErrors: [],
      },
    },
  },
  system: {
    uptimeSeconds: 3600,
    memoryUsageMb: 128.5,
    pid: 42,
    version: '0.10.1',
    timestamp: '2026-08-06T00:00:00.000Z',
  },
  backup: {
    lastSuccessAtMs: null,
    pitrWalLagBytes: null,
    pitrBaseBackupAgeHours: null,
    pitrArchivingActive: null,
    pitrCheckedAtMs: null,
  },
};

const queueStats: JobQueueStats = {
  queued: 4,
  running: 1,
  completed: 99,
  failed: 2,
  deadLetter: 0,
  total: 106,
};

describe('renderPrometheusMetrics', () => {
  it('emits counters, gauges and per-stage/provider series', () => {
    const body = renderPrometheusMetrics(snapshot, queueStats, 5);

    expect(body).toContain('dominus_up 1');
    expect(body).toContain('dominus_uptime_seconds 3600');
    expect(body).toContain('dominus_memory_usage_mb 128.5');
    expect(body).toContain('dominus_pipeline_runs_total 3');
    expect(body).toContain('dominus_candidates_total 41');
    expect(body).toContain('dominus_recommended_total 2');
    expect(body).toContain('dominus_last_run_duration_ms 1200');
    expect(body).toContain('dominus_stage_runs_total{stage="dns"} 3');
    expect(body).toContain('dominus_stage_errors_total{stage="dns"} 1');
    expect(body).toContain('dominus_provider_calls_total{provider="rdap"} 10');
    expect(body).toContain('dominus_provider_errors_total{provider="rdap"} 2');
    expect(body).toContain('dominus_queue_queued 4');
    expect(body).toContain('dominus_queue_running 1');
    expect(body).toContain('dominus_queue_dead_letter_total 5');
    expect(body).toContain('dominus_app_info{version="0.10.1"} 1');
  });

  it('types monotonic families as counters and instantaneous values as gauges', () => {
    const body = renderPrometheusMetrics(snapshot, queueStats, 5);
    expect(body).toContain('# TYPE dominus_stage_errors_total counter');
    expect(body).toContain('# TYPE dominus_provider_calls_total counter');
    expect(body).toContain('# TYPE dominus_queue_dead_letter_total counter');
    expect(body).toContain('# TYPE dominus_pipeline_runs_total counter');
    expect(body).toContain('# TYPE dominus_up gauge');
    expect(body).toContain('# TYPE dominus_uptime_seconds gauge');
    expect(body).toContain('# TYPE dominus_queue_queued gauge');
  });

  it('escapes label values per the exposition format', () => {
    const dirty = structuredClone(snapshot);
    dirty.pipeline.stageMetrics = {
      'we"ird\\stage': {
        stageName: 'we"ird\\stage',
        totalDurationMs: 0,
        totalPassed: 0,
        totalFiltered: 0,
        runCount: 0,
        lastRunAt: null,
        errorCount: 0,
      },
    };
    const body = renderPrometheusMetrics(dirty, queueStats, 0);
    expect(body).toContain('stage="we\\"ird\\\\stage"');
  });

  it('omits gauges with no value instead of emitting NaN', () => {
    const noDuration = structuredClone(snapshot);
    noDuration.pipeline.lastRunDurationMs = null;
    const body = renderPrometheusMetrics(noDuration, queueStats, 0);
    expect(body).not.toContain('dominus_last_run_duration_ms NaN');
    expect(body).not.toContain('dominus_last_run_duration_ms');
  });

  it('emits dns_consensus series only after consensus is observed (ADR-0039)', () => {
    const pre = renderPrometheusMetrics(snapshot, queueStats, 0);
    expect(pre).not.toContain('dominus_dns_consensus_verified_total');
    expect(pre).not.toContain('dominus_dns_consensus_tertiary_rescued_total');

    const withConsensus = structuredClone(snapshot);
    withConsensus.pipeline.dnsConsensus = {
      verifiedTotal: 12,
      disagreedTotal: 2,
      unverifiableTotal: 6,
      degradedRunsTotal: 1,
      lastRunDegraded: true,
      observed: true,
      tertiaryRescuedTotal: 4,
    };
    const body = renderPrometheusMetrics(withConsensus, queueStats, 0);

    expect(body).toContain('dominus_dns_consensus_verified_total 12');
    expect(body).toContain('dominus_dns_consensus_disagreed_total 2');
    expect(body).toContain('dominus_dns_consensus_unverifiable_total 6');
    expect(body).toContain('dominus_dns_consensus_degraded_runs_total 1');
    expect(body).toContain('dominus_dns_consensus_last_run_degraded 1');
    expect(body).toContain('dominus_dns_consensus_tertiary_rescued_total 4');
    expect(body).toContain('# TYPE dominus_dns_consensus_verified_total counter');
    expect(body).toContain('# TYPE dominus_dns_consensus_tertiary_rescued_total counter');
    expect(body).toContain('# TYPE dominus_dns_consensus_last_run_degraded gauge');
  });

  it('renders the last-run degraded gauge as 0 when the latest run was clean', () => {
    const withConsensus = structuredClone(snapshot);
    withConsensus.pipeline.dnsConsensus = {
      verifiedTotal: 3,
      disagreedTotal: 0,
      unverifiableTotal: 0,
      degradedRunsTotal: 1,
      lastRunDegraded: false,
      observed: true,
      tertiaryRescuedTotal: 0,
    };
    const body = renderPrometheusMetrics(withConsensus, queueStats, 0);
    expect(body).toContain('dominus_dns_consensus_last_run_degraded 0');
  });

  it('emits trademark gate series only after the gate is observed', () => {
    const pre = renderPrometheusMetrics(snapshot, queueStats, 0);
    expect(pre).not.toContain('dominus_trademark_gate_clear_total');
    expect(pre).not.toContain('dominus_trademark_gate_unverified_total');

    const withGate = structuredClone(snapshot);
    withGate.pipeline.trademarkGate = {
      clearTotal: 14,
      blockedTotal: 2,
      unverifiedTotal: 3,
      partialTotal: 5,
      usptoFailuresTotal: 4,
      euipoFailuresTotal: 1,
      observed: true,
    };
    const body = renderPrometheusMetrics(withGate, queueStats, 0);

    expect(body).toContain('dominus_trademark_gate_clear_total 14');
    expect(body).toContain('dominus_trademark_gate_blocked_total 2');
    expect(body).toContain('dominus_trademark_gate_unverified_total 3');
    expect(body).toContain('dominus_trademark_gate_partial_total 5');
    expect(body).toContain('dominus_trademark_gate_uspto_failures_total 4');
    expect(body).toContain('dominus_trademark_gate_euipo_failures_total 1');
    expect(body).toContain('# TYPE dominus_trademark_gate_clear_total counter');
    expect(body).toContain('# TYPE dominus_trademark_gate_unverified_total counter');
  });

  it('emits rdap consensus and bootstrap series only after observed (ADR-0058)', () => {
    const pre = renderPrometheusMetrics(snapshot, queueStats, 0);
    expect(pre).not.toContain('dominus_rdap_consensus_verified_total');
    expect(pre).not.toContain('dominus_rdap_consensus_origin_overlap_total');
    expect(pre).not.toContain('dominus_rdap_bootstrap_ok');

    const withRdap = structuredClone(snapshot);
    withRdap.pipeline.rdapConsensus = {
      verifiedTotal: 9,
      disagreedTotal: 1,
      unverifiableTotal: 3,
      whoisRescuedTotal: 2,
      originOverlapTotal: 4,
      originGuardUnavailableTotal: 1,
      degradedRunsTotal: 1,
      lastRunDegraded: true,
      observed: true,
    };
    withRdap.rdapBootstrap = {
      ok: true,
      consecutiveFailures: 0,
      lastSuccessAtMs: 1_700_000_000_000,
      nextRetryAtMs: null,
      observed: true,
    };
    const body = renderPrometheusMetrics(withRdap, queueStats, 0);

    expect(body).toContain('dominus_rdap_consensus_verified_total 9');
    expect(body).toContain('dominus_rdap_consensus_disagreed_total 1');
    expect(body).toContain('dominus_rdap_consensus_unverifiable_total 3');
    expect(body).toContain('dominus_rdap_consensus_whois_rescued_total 2');
    expect(body).toContain('dominus_rdap_consensus_origin_overlap_total 4');
    expect(body).toContain('dominus_rdap_consensus_origin_guard_unavailable_total 1');
    expect(body).toContain('dominus_rdap_consensus_degraded_runs_total 1');
    expect(body).toContain('dominus_rdap_consensus_last_run_degraded 1');
    expect(body).toContain('# TYPE dominus_rdap_consensus_verified_total counter');
    expect(body).toContain('# TYPE dominus_rdap_consensus_origin_overlap_total counter');
    expect(body).toContain('# TYPE dominus_rdap_consensus_last_run_degraded gauge');
    expect(body).toContain('dominus_rdap_bootstrap_ok 1');
    expect(body).toContain('dominus_rdap_bootstrap_failures_total 0');
    expect(body).toContain('# TYPE dominus_rdap_bootstrap_ok gauge');
    expect(body).toContain('# TYPE dominus_rdap_bootstrap_failures_total counter');
  });
});
