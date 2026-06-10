import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { WhoisProvider, WhoisResult } from '../../providers/whois/whois-provider.js';
import type { Stage, StageResult } from '../stage.js';

interface AvailabilityResult {
  domain: string;
  status: DomainStatus;
  isPremium: boolean;
  registrar?: string | undefined;
  expiresAt?: string | undefined;
  checkedAt: string;
  source: 'rdap' | 'whois';
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

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
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

    if (rdapSettled.status === 'fulfilled') {
      return rdapToResult(rdapSettled.value);
    }

    if (whoisSettled.status === 'fulfilled') {
      return whoisToResult(whoisSettled.value);
    }

    throw rdapSettled.reason;
  }
}
