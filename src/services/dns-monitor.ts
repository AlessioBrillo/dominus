// SPDX-License-Identifier: AGPL-3.0-only

export interface DnsProbeResult {
  durationMs: number;
  success: boolean;
  errorType?: string;
}

export interface DnsMonitorMetrics {
  totalQueries: number;
  totalErrors: number;
  ewmaLatencyMs: number;
  isDegraded: boolean;
}

/**
 * DnsMonitor tracks DNS resolution performance (latency, error rate)
 * and provides adaptive load shedding heuristics (ADR-0075/0078 context).
 */
export class DnsMonitor {
  private totalQueries = 0;
  private totalErrors = 0;
  private ewmaLatencyMs = 0;
  private readonly alpha = 0.1; // EWMA smoothing factor
  private readonly latencyThresholdMs = 500;
  private readonly errorRateThreshold = 0.1; // 10%

  constructor() {}

  public recordProbe(result: DnsProbeResult): void {
    this.totalQueries++;
    if (!result.success) {
      this.totalErrors++;
    }

    // EWMA for latency
    if (this.ewmaLatencyMs === 0) {
      this.ewmaLatencyMs = result.durationMs;
    } else {
      this.ewmaLatencyMs = this.alpha * result.durationMs + (1 - this.alpha) * this.ewmaLatencyMs;
    }
  }

  public getMetrics(): DnsMonitorMetrics {
    const errorRate = this.totalQueries > 0 ? this.totalErrors / this.totalQueries : 0;
    const isDegraded =
      this.ewmaLatencyMs > this.latencyThresholdMs || errorRate > this.errorRateThreshold;

    return {
      totalQueries: this.totalQueries,
      totalErrors: this.totalErrors,
      ewmaLatencyMs: this.ewmaLatencyMs,
      isDegraded,
    };
  }
}
