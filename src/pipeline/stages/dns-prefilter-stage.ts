import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { CandidateSource, DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { Stage, StageResult } from '../stage.js';
import { isValidDomain } from '../../utils/domain.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export class DnsPreFilterStage implements Stage<DomainCandidate> {
  readonly name = 'DnsPreFilterStage';

  constructor(
    private readonly dnsProvider: DnsProvider,
    private readonly fallbackConcurrency: number = 10,
    private readonly skipSources: CandidateSource[] = [],
  ) {}

  async process(
    candidates: DomainCandidate[],
    _signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    const toFilter: DomainCandidate[] = [];
    const toSkip: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];
    const skipSet = new Set(this.skipSources);

    for (const c of candidates) {
      if (skipSet.has(c.source)) {
        toSkip.push({ ...c, dnsStatus: 'skipped', status: CandidateStatus.Pending });
      } else if (!isValidDomain(c.domain)) {
        filtered.push({
          ...c,
          dnsStatus: 'invalid',
          status: CandidateStatus.DnsFiltered,
        });
      } else {
        toFilter.push(c);
      }
    }

    const perDomainResults = await this.#resolveBulkWithFallback(toFilter);

    const passed: DomainCandidate[] = [...toSkip];

    for (let i = 0; i < toFilter.length; i++) {
      const candidate = toFilter[i];
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
    if (domains.length === 0) return [];

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

    const results: (DnsCheckResult | undefined)[] = new Array(domains.length);
    for (let i = 0; i < domains.length; i += this.fallbackConcurrency) {
      const batch = domains.slice(i, i + this.fallbackConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (c) => {
          try {
            return await this.dnsProvider.checkAvailability(c.domain);
          } catch {
            logger.error({ domain: c.domain }, 'DNS per-domain check failed');
            return undefined;
          }
        }),
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }
    return results;
  }
}
