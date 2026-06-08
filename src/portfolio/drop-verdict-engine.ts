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

  if (score < config.scoreThreshold && clock.daysUntilRenewal <= config.renewalHorizonDays) {
    return {
      domain: entry.domain,
      verdict: Verdict.Drop,
      reason: `Score ${score.toFixed(1)} < threshold ${config.scoreThreshold} and renewal in ${clock.daysUntilRenewal} days`,
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
