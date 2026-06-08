import type { WatchlistRepository } from '../db/repositories/watchlist-repository.js';
import type { DnsProvider } from '../providers/dns/dns-provider.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { Notifier } from '../notifiers/notifier.js';
import type { Config } from '../config.js';
import type { WatchlistEntry, WatchlistPollResult } from '../types/watchlist.js';
import type { InsertWatchlistInput } from '../types/watchlist.js';
import { AlertType, AlertSeverity } from '../types/alert.js';
import { DomainStatus } from '../types/domain-status.js';
import type { RdapResult } from '../types/domain-status.js';
import { sendAlert } from '../notifiers/notifier-router.js';
import { getLogger } from '../logger.js';
import { parseDomain } from '../utils/domain.js';

const logger = getLogger();

export class WatchlistService {
  constructor(
    private readonly repo: WatchlistRepository,
    private readonly dnsProvider: DnsProvider,
    private readonly rdapProvider: RdapProvider,
    private readonly notifiers: Notifier[],
    private readonly config: Config,
  ) {}

  add(domain: string, notes?: string): WatchlistEntry {
    const parsed = parseDomain(domain);
    const tld = parsed.tld ?? 'unknown';
    return this.repo.insert({ domain, tld, notes });
  }

  remove(domain: string): boolean {
    return this.repo.remove(domain);
  }

  list(): WatchlistEntry[] {
    return this.repo.list();
  }

  get(domain: string): WatchlistEntry | null {
    return this.repo.findByDomain(domain);
  }

  async poll(dryRun = false): Promise<WatchlistPollResult> {
    const entries = this.repo.listPendingPoll(this.config.WATCHLIST_POLL_INTERVAL_HOURS);
    const result: WatchlistPollResult = { checked: 0, available: 0, notified: 0, errors: 0 };

    if (entries.length === 0) {
      logger.info('watchlist poll: no entries pending check');
      return result;
    }

    logger.info({ count: entries.length }, 'watchlist poll: starting');

    for (const entry of entries) {
      try {
        const available = await this.#checkEntry(entry, dryRun);
        if (available) {
          result.available++;
          if (!dryRun) {
            result.notified++;
          }
        }
        result.checked++;
      } catch (err) {
        logger.error({ err, domain: entry.domain }, 'watchlist poll: error checking domain');
        result.errors++;
      }

      if (entries.length > 1) {
        await sleep(this.config.WATCHLIST_RDAP_DELAY_MS);
      }
    }

    logger.info(
      { checked: result.checked, available: result.available, notified: result.notified, errors: result.errors },
      'watchlist poll: complete',
    );

    return result;
  }

  async #checkEntry(entry: WatchlistEntry, dryRun: boolean): Promise<boolean> {
    const { domain } = entry;

    const dnsResult = await this.dnsProvider.checkAvailability(domain);

    if (dnsResult.status === DomainStatus.Registered) {
      await this.repo.updateStatus(domain, {
        lastCheckedAt: new Date().toISOString(),
        lastStatus: DomainStatus.Registered,
        lastStatusChange: null,
      });
      logger.debug({ domain }, 'watchlist: still registered (DNS)');
      return false;
    }

    if (dnsResult.status === DomainStatus.Unknown) {
      logger.warn({ domain }, 'watchlist: DNS check inconclusive, skipping RDAP');
      await this.repo.updateStatus(domain, {
        lastCheckedAt: new Date().toISOString(),
        lastStatus: DomainStatus.Unknown,
        lastStatusChange: null,
      });
      return false;
    }

    let rdapResult: RdapResult;
    try {
      rdapResult = await this.rdapProvider.confirm(domain);
    } catch (err) {
      logger.warn({ err, domain }, 'watchlist: RDAP confirm failed after DNS suggested available');
      await this.repo.updateStatus(domain, {
        lastCheckedAt: new Date().toISOString(),
        lastStatus: DomainStatus.Unknown,
        lastStatusChange: null,
      });
      return false;
    }

    const now = new Date().toISOString();
    const prevStatus = entry.lastStatus;
    const changed = prevStatus !== null && prevStatus !== rdapResult.status;

    await this.repo.updateStatus(domain, {
      lastCheckedAt: now,
      lastStatus: rdapResult.status,
      lastStatusChange: changed || prevStatus === null ? now : null,
    });

    if (rdapResult.status !== DomainStatus.Available) {
      logger.debug({ domain, status: rdapResult.status }, 'watchlist: not available (RDAP)');
      return false;
    }

    if (entry.notified === 1) {
      logger.debug({ domain }, 'watchlist: already notified for availability');
      return false;
    }

    if (dryRun) {
      logger.info({ domain }, 'watchlist: [DRY-RUN] domain available!');
      return true;
    }

    await this.#notifyAvailable(domain);
    await this.repo.markNotified(domain);
    logger.info({ domain }, 'watchlist: domain available — notified');
    return true;
  }

  async #notifyAvailable(domain: string): Promise<void> {
    await sendAlert(this.notifiers, {
      domain,
      alertType: AlertType.DomainAvailable,
      severity: AlertSeverity.Success,
      message: `Domain ${domain} is now available!`,
      details: 'The domain was detected as available via RDAP check.',
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
