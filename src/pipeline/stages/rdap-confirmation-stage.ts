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
  ) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.#checkAvailability(candidate.domain);
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
      } catch {
        filtered.push({
          ...candidate,
          rdapStatus: 'error',
          status: CandidateStatus.RdapFiltered,
        });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }

  async #checkAvailability(domain: string): Promise<AvailabilityResult> {
    // Run RDAP and WHOIS in parallel when WHOIS is configured.
    // RDAP is preferred (has premium detection, richer metadata).
    // WHOIS is the fallback for ccTLDs and registries that block RDAP.
    if (this.whoisProvider === undefined) {
      const rdap = await this.rdapProvider.confirm(domain);
      return rdapToResult(rdap);
    }

    const [rdapSettled, whoisSettled] = await Promise.allSettled([
      this.rdapProvider.confirm(domain),
      this.whoisProvider.checkAvailability(domain),
    ]);

    // RDAP success → prefer RDAP (better metadata, premium detection)
    if (rdapSettled.status === 'fulfilled') {
      return rdapToResult(rdapSettled.value);
    }

    // RDAP failed → fall back to WHOIS
    if (whoisSettled.status === 'fulfilled') {
      return whoisToResult(whoisSettled.value);
    }

    // Both failed → rethrow the RDAP error for consistent messaging
    throw rdapSettled.reason;
  }
}
