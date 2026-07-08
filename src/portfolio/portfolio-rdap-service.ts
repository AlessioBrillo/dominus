import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { WhoisProvider } from '../providers/whois/whois-provider.js';
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { PortfolioEntry } from '../types/portfolio.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface HealthcheckResult {
  checked: number;
  updated: number;
  errors: number;
  details: Array<{ domain: string; action: 'updated' | 'unchanged' | 'error'; message: string }>;
}

/**
 * Verifies portfolio domains against live RDAP and WHOIS data.
 *
 * RDAP is the primary source (authoritative per ICANN). WHOIS is used as
 * fallback when RDAP returns insufficient data (e.g. missing expiry date).
 * This is the inverse of the pipeline RDAP stage which uses WHOIS for
 * cross-validation — here we only need the expiry date for renewal tracking.
 *
 * Rate limiting is handled by the injected provider instances (token bucket
 * configured at composition root). The healthcheck runs in batches and
 * respects the provider's concurrency limits.
 */
export class PortfolioRdapService {
  readonly #rdapProvider: RdapProvider;
  readonly #whoisProvider: WhoisProvider;
  readonly #portfolioRepo: PortfolioRepository;

  constructor(
    rdapProvider: RdapProvider,
    whoisProvider: WhoisProvider,
    portfolioRepo: PortfolioRepository,
  ) {
    this.#rdapProvider = rdapProvider;
    this.#whoisProvider = whoisProvider;
    this.#portfolioRepo = portfolioRepo;
  }

  /**
   * Check a single portfolio entry against live RDAP/WHOIS data.
   * Updates the entry's renewal date if the provider returns a more recent one.
   */
  async checkOne(
    entry: PortfolioEntry,
    signal?: AbortSignal,
  ): Promise<{
    action: 'updated' | 'unchanged' | 'error';
    message: string;
  }> {
    try {
      // RDAP is primary — authoritative registry data
      const rdap = await this.#rdapProvider.confirm(entry.domain, signal);

      if (rdap.status === 'registered' && rdap.expiresAt) {
        const providerDate = rdap.expiresAt;
        const storedDate = entry.lastWhoisRenewalDate ?? entry.renewalDate;

        if (providerDate !== storedDate) {
          await this.#portfolioRepo.updateVerificationTimestamp(entry.domain, providerDate);
          return {
            action: 'updated',
            message: `RDAP expiry ${providerDate} differs from stored ${storedDate}`,
          };
        }

        await this.#portfolioRepo.updateVerificationTimestamp(entry.domain);
        return { action: 'unchanged', message: 'RDAP verified, no change' };
      }

      // RDAP returned no expiry date — use WHOIS as fallback
      const whois = await this.#whoisProvider.checkAvailability(entry.domain, signal);
      if (
        whois.expiryDate &&
        whois.expiryDate !== (entry.lastWhoisRenewalDate ?? entry.renewalDate)
      ) {
        await this.#portfolioRepo.updateVerificationTimestamp(entry.domain, whois.expiryDate);
        return {
          action: 'updated',
          message: `WHOIS expiry ${whois.expiryDate} differs from stored (RDAP had no expiry)`,
        };
      }

      await this.#portfolioRepo.updateVerificationTimestamp(entry.domain);
      return { action: 'unchanged', message: 'WHOIS verified, no change' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ domain: entry.domain, err }, 'PortfolioRdapService: check failed');
      return { action: 'error', message };
    }
  }

  /**
   * Batch check portfolio entries that are due for renewal verification.
   * Defaults to checking entries expiring within 90 days with stale verification.
   */
  async checkExpiring(
    horizonDays: number = 90,
    batchSize: number = 100,
    signal?: AbortSignal,
  ): Promise<HealthcheckResult> {
    const entries = await this.#portfolioRepo.getExpiringInDays(horizonDays, batchSize);
    return this.#checkBatch(entries, signal);
  }

  /**
   * Check a specific list of portfolio entries.
   */
  async checkEntries(entries: PortfolioEntry[], signal?: AbortSignal): Promise<HealthcheckResult> {
    return this.#checkBatch(entries, signal);
  }

  async #checkBatch(entries: PortfolioEntry[], signal?: AbortSignal): Promise<HealthcheckResult> {
    const details: HealthcheckResult['details'] = [];
    let updated = 0;
    let errors = 0;

    for (const entry of entries) {
      if (signal?.aborted) break;

      const result = await this.checkOne(entry, signal);
      details.push({ domain: entry.domain, ...result });
      if (result.action === 'updated') updated++;
      else if (result.action === 'error') errors++;
    }

    logger.info(
      { checked: entries.length, updated, errors },
      'PortfolioRdapService: healthcheck batch complete',
    );

    return { checked: entries.length, updated, errors, details };
  }
}
