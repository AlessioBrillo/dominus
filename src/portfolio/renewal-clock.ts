// SPDX-License-Identifier: AGPL-3.0-only
import type { PortfolioEntry } from '../types/portfolio.js';
import type { RenewalClockData } from '../types/portfolio.js';

export function computeRenewalClock(entry: PortfolioEntry): RenewalClockData {
  const now = new Date();
  const renewal = new Date(entry.renewalDate);
  // Compare calendar days (UTC midnight), not exact 24h deltas: a renewal
  // expiring later today must read as 0 days, not -1 just because a few
  // milliseconds elapsed between reading "now" and parsing the renewal date.
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilRenewal = Math.round(
    (Date.UTC(renewal.getUTCFullYear(), renewal.getUTCMonth(), renewal.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
      msPerDay,
  );

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
