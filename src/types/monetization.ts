// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Monetization types (ADR-0083, M3).
 *
 * Revenue ingestion is a READ, never a write (ADR-0083 amendment
 * 2026-10-14): the monetization layer only records what a provider
 * reports about ad revenue. It never mutates external state, and every
 * figure it stores goes through the same scrutiny as any other value
 * feeding a verdict — the carry-cost verdict of M5 depends on it.
 */

/** One day of reported ad revenue for one domain. */
export interface RevenueRecord {
  domain: string;
  /** Revenue day, ISO date (YYYY-MM-DD). */
  date: string;
  /** Revenue in EUR. Negative values are corrections, never rejected. */
  amountEur: number;
  /** Provider that reported the figure (e.g. 'csv', 'sedo'). */
  source: string;
  /** ISO-8601 timestamp of the ingestion. */
  fetchedAt: string;
}

/**
 * Monetization provider abstraction (Principle 1). Adding a new
 * monetization source means writing exactly one adapter; nothing else
 * changes. The community edition ships a CSV reader — zero paid API
 * dependencies; provider-specific adapters land only with verified API
 * access (ADR-0082).
 */
export interface MonetizationProvider {
  readonly name: string;
  /** False when not configured: the parking step skips honestly. */
  readonly isAvailable: boolean;
  /**
   * Revenue reported for all domains since `since` (ISO date, inclusive).
   * Returns an empty array when the provider has nothing new.
   */
  fetchRevenue(since: string): Promise<RevenueRecord[]>;
}

/** Aggregate revenue figures for one domain. */
export interface DomainRevenueSummary {
  domain: string;
  totalEur: number;
  /** Revenue recorded in the last 30 days, EUR. */
  last30DaysEur: number;
  /** ISO date of the most recent record, or null when none. */
  lastRecordDate: string | null;
  records: number;
}

export interface RevenueRow {
  id: number;
  domain: string;
  revenue_date: string;
  amount_eur: number;
  source: string;
  fetched_at: string;
  tenant_id: string;
}
