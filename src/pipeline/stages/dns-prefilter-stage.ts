import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { Stage, StageResult } from '../stage.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export class DnsPreFilterStage implements Stage<DomainCandidate> {
  readonly name = 'DnsPreFilterStage';

  constructor(private readonly dnsProvider: DnsProvider) {}

  async process(candidates: DomainCandidate[]): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();

    const perDomainResults = await this.#resolveBulkWithFallback(candidates);

    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const result = perDomainResults[i];
      if (candidate === undefined) continue;

      if (result === undefined) {
        filtered.push({
          ...candidate,
          dnsStatus: 'error',
          status: CandidateStatus.Unscored,
        });
        continue;
      }

      if (result.status === DomainStatus.Available || result.status === DomainStatus.Unknown) {
        passed.push({ ...candidate, dnsStatus: result.status, status: CandidateStatus.Pending });
      } else {
        filtered.push({
          ...candidate,
          dnsStatus: result.status,
          status: CandidateStatus.DnsFiltered,
        });
      }
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }

  async #resolveBulkWithFallback(
    domains: DomainCandidate[],
  ): Promise<(DnsCheckResult | undefined)[]> {
    try {
      const results = await this.dnsProvider.checkBulk(domains.map((c) => c.domain));
      if (results.length === domains.length) return results;
      logger.warn(
        { expected: domains.length, got: results.length },
        'DNS bulk check returned mismatched result count — falling back to per-domain checks',
      );
    } catch (err) {
      logger.warn({ err }, 'DNS bulk check threw — falling back to per-domain checks');
    }

    return Promise.all(
      domains.map(async (c) => {
        try {
          return await this.dnsProvider.checkAvailability(c.domain);
        } catch {
          logger.error({ domain: c.domain }, 'DNS per-domain check failed');
          return undefined;
        }
      }),
    );
  }
}
