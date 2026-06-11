import type { PortfolioEntry } from '../types/portfolio.js';
import { Verdict } from '../types/portfolio.js';
import { computeRenewalClock } from './renewal-clock.js';

export interface DropVerdictResult {
  domain: string;
  verdict: Verdict;
  reason: string;
}

export interface DropVerdictConfig {
  scoreThreshold: number;
  renewalHorizonDays: number;
}

export function computeDropVerdict(
  entry: PortfolioEntry,
  config: DropVerdictConfig,
): DropVerdictResult {
  const clock = computeRenewalClock(entry);
  const score = entry.currentScore ?? 0;

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
