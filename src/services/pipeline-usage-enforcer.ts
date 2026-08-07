// SPDX-License-Identifier: AGPL-3.0-only
import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';
import type { UsageFeature } from '../types/usage.js';
import { UsageMeterService } from './usage-meter-service.js';
import { getTenantId } from '../utils/tenant-context.js';

/**
 * Conservative estimate of how many candidates a pipeline run will score:
 * the total number of explicitly supplied inputs (keywords, brandable
 * names, closeout domains/entries, direct domains). This is the "input
 * size" metered at enqueue time — deliberately conservative, because the
 * vendor-side meter must never undercount (see Q4 decision in ADR-0038).
 */
export function estimateCandidateCount(input: CandidateGenerationInput): number {
  if (input === undefined || input === null) return 1;
  const total =
    (input.keywords?.length ?? 0) +
    (input.brandableNames?.length ?? 0) +
    (input.closeoutDomains?.length ?? 0) +
    (input.closeoutEntries?.length ?? 0) +
    (input.domains?.length ?? 0);
  return Math.max(1, total);
}

/**
 * Entry-point guard for metered features outside the HTTP layer (pipeline
 * runs, portfolio/watchlist additions). Mirrors the API usage middleware:
 * when enforcement is disabled (USAGE_ENFORCEMENT_ENABLED=false, the
 * community default) it is a strict no-op — it never records, so existing
 * deployments observe zero behavior change.
 *
 * Metering is atomic against the plan limit (see
 * UsageRepository.incrementUsageIfWithinLimit), so concurrent runs can
 * never overshoot the allowance; when the budget is exhausted the caller
 * receives a UsageLimitExceededError (HTTP 429 at the route boundary).
 */
export class PipelineUsageEnforcer {
  readonly #usageService: UsageMeterService;
  readonly #enabled: boolean;

  constructor(usageService: UsageMeterService, enabled: boolean) {
    this.#usageService = usageService;
    this.#enabled = enabled;
  }

  /** Whether enforcement is active (USAGE_ENFORCEMENT_ENABLED=true). */
  get enabled(): boolean {
    return this.#enabled;
  }

  async checkAndRecord(feature: UsageFeature, amount: number): Promise<void> {
    if (!this.#enabled) return;
    const tenantId = getTenantId() ?? 'default';
    const periodStart = UsageMeterService.periodStart(new Date().toISOString());
    await this.#usageService.record(tenantId, feature, amount, periodStart);
  }

  /** Meter a pipeline run against the candidates_scored allowance. */
  async checkAndRecordCandidates(input: CandidateGenerationInput): Promise<void> {
    await this.checkAndRecord('candidates_scored', estimateCandidateCount(input));
  }

  /** Meter a portfolio/watchlist addition against the domains_tracked allowance. */
  async checkAndRecordTracked(amount: number = 1): Promise<void> {
    await this.checkAndRecord('domains_tracked', amount);
  }

  /**
   * Refund a domains_tracked unit (floor 0) when the tracked insert failed
   * after the meter ran (duplicate, invalid domain, FK violation). Must only
   * be called for units this enforcer already consumed; a no-op when
   * enforcement is disabled (ADR-0038, failure policy).
   */
  async refundTracked(amount: number = 1): Promise<void> {
    if (!this.#enabled) return;
    const tenantId = getTenantId() ?? 'default';
    const periodStart = UsageMeterService.periodStart(new Date().toISOString());
    await this.#usageService.refund(tenantId, 'domains_tracked', amount, periodStart);
  }
}
