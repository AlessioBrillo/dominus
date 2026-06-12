import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { WhoisProvider, WhoisResult } from '../../providers/whois/whois-provider.js';
import type { Stage, StageResult } from '../stage.js';
import { getLogger } from '../../logger.js';

interface AvailabilityResult {
  domain: string;
  status: DomainStatus;
  isPremium: boolean;
  registrar?: string | undefined;
  expiresAt?: string | undefined;
  checkedAt: string;
  source: 'rdap' | 'whois' | 'cross-validated';
}

function rdapToResult(r: RdapResult): AvailabilityResult {
  return {
    domain: r.domain,
    status: r.status,
    isPremium: r.isPremium,
    registrar: r.registrar,
    expiresAt: r.expiresAt,
    checkedAt: r.checkedAt,
    source: 'rdap',
  };
}

function whoisToResult(r: WhoisResult): AvailabilityResult {
  return {
    domain: r.domain,
    status: r.available ? DomainStatus.Available : DomainStatus.Registered,
    isPremium: false,
    registrar: r.registrar,
    expiresAt: r.expiryDate,
    checkedAt: r.checkedAt,
    source: 'whois',
  };
}

export class RdapConfirmationStage implements Stage<DomainCandidate> {
  readonly name = 'RdapConfirmationStage';

  constructor(
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider?: WhoisProvider,
    private readonly concurrency: number = 5,
  ) {}

  async process(
    candidates: DomainCandidate[],
    _signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    // Process in batches to control concurrency while allowing parallel RDAP lookups
    const batches = this.#toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          const result = await this.#checkAvailability(candidate.domain);
          return { candidate, result };
        }),
      );
      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          const { candidate, result } = settled.value;
          if (result.status === DomainStatus.Available && !result.isPremium) {
            passed.push({
              ...candidate,
              rdapStatus: result.status,
              isPremium: false,
              status: CandidateStatus.Pending,
            });
          } else {
            filtered.push({
              ...candidate,
              rdapStatus: result.status,
              isPremium: result.isPremium,
              status: CandidateStatus.RdapFiltered,
            });
          }
        } else {
          const failed = batch[candidates.indexOf(settled.reason?.candidate ?? batch[0]!)];
          if (failed) {
            filtered.push({
              ...failed,
              rdapStatus: 'error',
              status: CandidateStatus.RdapFiltered,
            });
          }
        }
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }

  #toBatches<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }
    return batches;
  }

  async #checkAvailability(domain: string): Promise<AvailabilityResult> {
    if (this.whoisProvider === undefined) {
      const rdap = await this.rdapProvider.confirm(domain);
      return rdapToResult(rdap);
    }

    const [rdapSettled, whoisSettled] = await Promise.allSettled([
      this.rdapProvider.confirm(domain),
      this.whoisProvider.checkAvailability(domain),
    ]);

    if (rdapSettled.status === 'fulfilled' && whoisSettled.status === 'fulfilled') {
      return this.#crossValidate(domain, rdapSettled.value, whoisSettled.value);
    }

    if (rdapSettled.status === 'fulfilled') {
      return rdapToResult(rdapSettled.value);
    }

    if (whoisSettled.status === 'fulfilled') {
      return whoisToResult(whoisSettled.value);
    }

    throw rdapSettled.reason;
  }

  /**
   * Cross-validate RDAP and WHOIS results. When the two sources disagree
   * on availability status, WHOIS is preferred as the tiebreaker because
   * it queries the registry directly and is generally more up-to-date for
   * recent changes (expiry, redemption, pendingDelete). RDAP data can lag
   * behind by hours to days depending on the registry.
   *
   * Cross-validation is conservative: when in doubt, mark as Registered.
   * A false-positive Available (buying a taken domain) costs money;
   * a false-negative (missing an available domain) costs nothing.
   */
  #crossValidate(domain: string, rdap: RdapResult, whois: WhoisResult): AvailabilityResult {
    const rdapAvailable = rdap.status === DomainStatus.Available && !rdap.isPremium;
    const whoisAvailable = whois.available;

    if (rdapAvailable === whoisAvailable) {
      return {
        ...rdapToResult(rdap),
        source: 'cross-validated',
      };
    }

    // Disagreement: use WHOIS (more real-time), mark source as cross-validated
    getLogger().warn(
      {
        domain,
        rdapStatus: rdap.status,
        rdapIsPremium: rdap.isPremium,
        whoisAvailable,
        resolver: whoisAvailable ? 'whois' : 'rdap',
      },
      `RDAP/WHOIS cross-validation disagreement for ${domain} — ` +
        `RDAP says ${rdapAvailable ? 'available' : 'registered'}, ` +
        `WHOIS says ${whoisAvailable ? 'available' : 'registered'}. ` +
        `Using ${whoisAvailable ? 'WHOIS' : 'RDAP'} (conservative) result.`,
    );

    const result = whoisAvailable ? whoisToResult(whois) : rdapToResult(rdap);
    result.source = 'cross-validated';
    return result;
  }
}
