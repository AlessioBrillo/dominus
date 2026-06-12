import type { PortfolioEntry } from '../types/portfolio.js';
import { Verdict } from '../types/portfolio.js';
import { computeRenewalClock } from './renewal-clock.js';
import { computeNpv, type NpvInput } from './npv-calculator.js';

export type DropMethod = 'threshold' | 'npv';

export interface DropVerdictResult {
  domain: string;
  verdict: Verdict;
  reason: string;
  npv?: number | undefined;
}

export interface DropVerdictConfig {
  scoreThreshold: number;
  renewalHorizonDays: number;
  method: DropMethod;
  npvDiscountRate: number;
  npvHorizonYears: number;
}

export const DEFAULT_DROP_VERDICT_CONFIG: DropVerdictConfig = {
  scoreThreshold: 25,
  renewalHorizonDays: 60,
  method: 'threshold',
  npvDiscountRate: 0.05,
  npvHorizonYears: 5,
};

export function computeDropVerdict(
  entry: PortfolioEntry,
  config: DropVerdictConfig,
): DropVerdictResult {
  const clock = computeRenewalClock(entry);

  // Guard: if the domain has never been scored (currentScore is null/undefined),
  // we cannot issue a Drop verdict — doing so would treat an unscored domain
  // as a zero-scored one, causing false positives. The operator must rescore
  // before any drop decision.
  if (entry.currentScore === undefined || entry.currentScore === null) {
    return {
      domain: entry.domain,
      verdict: Verdict.Reprice,
      reason: 'Domain has not been scored yet — run portfolio rescore before any drop decision',
    };
  }

  const score = entry.currentScore;

  if (config.method === 'npv') {
    return computeNpvBasedDropVerdict(entry, config, clock);
  }

  return computeThresholdBasedDropVerdict(entry, config, clock, score);
}

function computeThresholdBasedDropVerdict(
  entry: PortfolioEntry,
  config: DropVerdictConfig,
  clock: ReturnType<typeof computeRenewalClock>,
  score: number,
): DropVerdictResult {
  // Caller guarantees score is defined — the public function handles null.
  const breakEvenRenewals =
    entry.acquisitionCost > 0 ? entry.acquisitionCost / (entry.renewalCost || 1) : 0;
  const daysSinceAcquisition =
    clock.daysUntilRenewal < 365
      ? 365 - clock.daysUntilRenewal
      : entry.acquiredAt
        ? Math.floor((Date.now() - new Date(entry.acquiredAt).getTime()) / 86400000)
        : 0;
  const renewalsPaid = Math.max(1, Math.ceil(daysSinceAcquisition / 365));
  const sunkCostRecouped = renewalsPaid >= breakEvenRenewals;

  if (score < config.scoreThreshold && clock.daysUntilRenewal <= config.renewalHorizonDays) {
    if (!sunkCostRecouped && entry.acquisitionCost > 0) {
      return {
        domain: entry.domain,
        verdict: Verdict.Reprice,
        reason: `Score ${score.toFixed(1)} below threshold but acquisition cost (€${entry.acquisitionCost}) not yet recouped — consider holding until break-even`,
      };
    }
    return {
      domain: entry.domain,
      verdict: Verdict.Drop,
      reason: `Score ${score.toFixed(1)} < threshold ${config.scoreThreshold} and renewal in ${clock.daysUntilRenewal} days (acquisition cost recouped: ${sunkCostRecouped})`,
    };
  }

  if (entry.suggestedListPrice !== undefined && entry.currentScore !== undefined) {
    const pricedForLong =
      clock.daysUntilRenewal <= config.renewalHorizonDays * 3 && score >= config.scoreThreshold;
    if (pricedForLong) {
      return {
        domain: entry.domain,
        verdict: Verdict.Reprice,
        reason: `Renewal approaching in ${clock.daysUntilRenewal} days — consider repricing`,
      };
    }
  }

  return { domain: entry.domain, verdict: Verdict.Keep, reason: 'No action required' };
}

function computeNpvBasedDropVerdict(
  entry: PortfolioEntry,
  config: DropVerdictConfig,
  clock: ReturnType<typeof computeRenewalClock>,
): DropVerdictResult {
  // Caller guarantees score is defined — the public function handles null.
  const safeScore = entry.currentScore!;
  const currentScoreNormalised = Math.min(1, Math.max(0, safeScore / 100));

  const npvInput: NpvInput = {
    expectedValue: entry.suggestedListPrice ?? safeScore * 5,
    confidence: currentScoreNormalised,
    acquisitionCost: entry.acquisitionCost,
    renewalCost: entry.renewalCost,
  };

  const npvResult = computeNpv(npvInput, config.npvDiscountRate, config.npvHorizonYears);

  const approachingRenewal = clock.daysUntilRenewal <= config.renewalHorizonDays;

  if (npvResult.npv < 0 && approachingRenewal) {
    if (entry.acquisitionCost > 0 && safeScore >= config.scoreThreshold) {
      return {
        domain: entry.domain,
        verdict: Verdict.Reprice,
        reason: `NPV negative (€${npvResult.npv.toFixed(2)}) but score ${safeScore.toFixed(1)} ≥ threshold — consider repricing before drop`,
        npv: npvResult.npv,
      };
    }
    return {
      domain: entry.domain,
      verdict: Verdict.Drop,
      reason: `NPV negative (€${npvResult.npv.toFixed(2)}) and renewal in ${clock.daysUntilRenewal} days. Renewal burn: €${npvResult.annualRenewalCost.toFixed(2)}/yr, projected annual return: €${npvResult.projectedAnnualReturn.toFixed(2)}`,
      npv: npvResult.npv,
    };
  }

  if (npvResult.npv < 0 && !approachingRenewal) {
    return {
      domain: entry.domain,
      verdict: Verdict.Reprice,
      reason: `NPV negative (€${npvResult.npv.toFixed(2)}) but renewal not imminent (${clock.daysUntilRenewal} days) — consider repricing or holding`,
      npv: npvResult.npv,
    };
  }

  if (npvResult.npv >= 0 && approachingRenewal && safeScore < config.scoreThreshold) {
    return {
      domain: entry.domain,
      verdict: Verdict.Reprice,
      reason: `NPV positive (€${npvResult.npv.toFixed(2)}) but score ${safeScore.toFixed(1)} < threshold — reprice before renewal`,
      npv: npvResult.npv,
    };
  }

  return {
    domain: entry.domain,
    verdict: Verdict.Keep,
    reason: `NPV positive (€${npvResult.npv.toFixed(2)}), renewal in ${clock.daysUntilRenewal} days`,
    npv: npvResult.npv,
  };
}
