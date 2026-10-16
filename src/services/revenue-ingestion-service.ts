// SPDX-License-Identifier: AGPL-3.0-only
import type { MonetizationProvider, RevenueRecord } from '../types/monetization.js';
import type { MonetizationRevenueRepository } from '../db/repositories/monetization-revenue-repository.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface RevenueIngestionDeps {
  /** Undefined (or unavailable) when no monetization source is configured. */
  provider: MonetizationProvider | undefined;
  repo: MonetizationRevenueRepository;
}

export interface DomainIngestionResult {
  domain: string;
  /** Records written (inserted or updated). */
  recorded: number;
  /** Total revenue recorded for the domain so far. */
  totalEur: number;
  /** Revenue recorded in the last 30 days. */
  last30DaysEur: number;
  /** Reason the ingestion could not run, when it did not. */
  skipped: string | null;
}

/**
 * Revenue ingestion (ADR-0083, M3).
 *
 * Ingestion is a READ: it records what the monetization provider reports
 * and never mutates external state. Every write is idempotent at
 * (domain, date, source) granularity, so a re-run of the parking step or
 * a repeated scheduled ingestion corrects figures instead of
 * double-counting them. Negative amounts are legitimate corrections and
 * are stored as reported.
 */
export class RevenueIngestionService {
  readonly #provider: MonetizationProvider | undefined;
  readonly #repo: MonetizationRevenueRepository;

  constructor(deps: RevenueIngestionDeps) {
    this.#provider = deps.provider;
    this.#repo = deps.repo;
  }

  /** True when a monetization source is configured and readable. */
  get isConfigured(): boolean {
    return this.#provider !== undefined && this.#provider.isAvailable;
  }

  /** Provider name for journal detail, or null when not configured. */
  get providerName(): string | null {
    return this.#provider !== undefined && this.#provider.isAvailable ? this.#provider.name : null;
  }

  /** Most recent revenue date recorded for a domain, or null when none. */
  async lastRecordDate(domain: string): Promise<string | null> {
    return this.#repo.lastRecordDate(domain);
  }

  /**
   * Ingest the revenue of one domain. `since` is the earliest date to
   * (re-)fetch; passing the last recorded date re-reads the most recent
   * day so provider corrections are picked up.
   */
  async ingestDomain(domain: string, since: string): Promise<DomainIngestionResult> {
    if (!this.isConfigured || this.#provider === undefined) {
      return { domain, recorded: 0, totalEur: 0, last30DaysEur: 0, skipped: 'not_configured' };
    }

    const records = (await this.#provider.fetchRevenue(since)).filter((r) => r.domain === domain);
    const recorded = await this.#repo.recordAll(records);

    const summary = await this.#repo.summarize(domain);
    logger.info(
      { domain, recorded, totalEur: summary.totalEur, since },
      'RevenueIngestionService: domain ingested',
    );

    return {
      domain,
      recorded,
      totalEur: summary.totalEur,
      last30DaysEur: summary.last30DaysEur,
      skipped: null,
    };
  }

  /**
   * Ingest everything the provider reports. Used by the scheduled
   * ingestion (M5); the parking step uses the per-domain variant.
   */
  async ingestAll(since: string): Promise<{ recorded: number; domains: string[] }> {
    if (!this.isConfigured || this.#provider === undefined) {
      return { recorded: 0, domains: [] };
    }

    const records = await this.#provider.fetchRevenue(since);
    const domains = [...new Set(records.map((r) => r.domain))];
    let recorded = 0;
    for (const domain of domains) {
      const forDomain = records.filter((r: RevenueRecord) => r.domain === domain);
      recorded += await this.#repo.recordAll(forDomain);
    }

    logger.info({ recorded, domains: domains.length, since }, 'RevenueIngestionService: ingested');
    return { recorded, domains };
  }
}
