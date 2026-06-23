import type { PortfolioEntry } from '../types/portfolio.js';
import type { RenewalClockData } from '../types/portfolio.js';

export function computeRenewalClock(entry: PortfolioEntry): RenewalClockData {
  const now = new Date();
  const renewal = new Date(entry.renewalDate);
  const diffMs = renewal.getTime() - now.getTime();
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilRenewal =
    diffMs < 0 ? Math.floor(diffMs / msPerDay) : Math.ceil(diffMs / msPerDay);

  return {
    domain: entry.domain,
    renewalDate: entry.renewalDate,
    daysUntilRenewal,
    renewalCost: entry.renewalCost,
  };
}

export function isRenewalImminent(entry: PortfolioEntry, horizonDays: number): boolean {
  const clock = computeRenewalClock(entry);
  return clock.daysUntilRenewal <= horizonDays;
}
