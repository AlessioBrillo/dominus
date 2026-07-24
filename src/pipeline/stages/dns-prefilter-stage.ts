import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { CandidateSource, DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { Stage, StageResult } from '../stage.js';
import { isValidDomain } from '../../utils/domain.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface ConsensusDnsConfig {
  /** Second DNS provider for cross-validation (e.g., using a different resolver group). */
  secondaryProvider: DnsProvider;
  /** TLDs requiring cross-validation. Default: all TLDs. */
  requiredTlds?: string[];
}

export class DnsPreFilterStage implements Stage<DomainCandidate> {
  readonly name = 'DnsPreFilterStage';

  constructor(
    private readonly dnsProvider: DnsProvider,
    private readonly fallbackConcurrency: number = 10,
    private readonly skipSources: CandidateSource[] = [],
    private readonly consensusConfig?: ConsensusDnsConfig,
  ) {}

  async process(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };

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

    const perDomainResults = await this.#resolveBulkWithFallback(toFilter, signal);

    const passed: DomainCandidate[] = [...toSkip];

    for (let i = 0; i < toFilter.length; i++) {
      const candidate = toFilter[i];
      const result = perDomainResults[i];
      if (candidate === undefined) continue;

      if (result === undefined) {
        filtered.push({
          ...candidate,
          dnsStatus: 'error',
          status: CandidateStatus.DnsFiltered,
        });
        continue;
      }

      if (result.status === DomainStatus.Available || result.isParked === true) {
        const dnsStatus = result.isParked ? 'parked' : result.status;
        passed.push({
          ...candidate,
          dnsStatus,
          status: CandidateStatus.Pending,
          ...(result.parkingRegistrar !== undefined
            ? { whoisMeta: { ...candidate.whoisMeta, registrar: result.parkingRegistrar } }
            : {}),
        });
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

  /** Threshold fraction of undefined results that triggers a cross-validation retry. */
  static readonly #CROSS_VALIDATE_UNDEFINED_THRESHOLD = 0.1;

  async #resolveBulkWithFallback(
    domains: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<(DnsCheckResult | undefined)[]> {
    if (domains.length === 0) return [];
    if (signal?.aborted) return new Array(domains.length);

    // Stage 1: fast bulk check from the DNS provider (multi-resolver race internally).
    const [bulkOk, results] = await this.#tryBulkCheck(domains, signal);
    if (!bulkOk || results === null) {
      return this.#perDomainFallback(results ?? new Array(domains.length), domains, signal);
    }

    // Stage 2: cross-validation when bulk has >10% undefined (timeout/error).
    const undefinedCount = results.filter((r) => r === undefined).length;
    if (undefinedCount > 0) {
      if (
        undefinedCount / results.length >=
        DnsPreFilterStage.#CROSS_VALIDATE_UNDEFINED_THRESHOLD
      ) {
        logger.warn(
          {
            undefinedCount,
            total: results.length,
            threshold: DnsPreFilterStage.#CROSS_VALIDATE_UNDEFINED_THRESHOLD,
          },
          'DNS bulk check high undefined ratio — cross-validating with individual retries',
        );
        const retried = await this.#retryUndefinedBatch(results, domains, signal);
        if (retried !== null) {
          const stillUndefined = retried.filter((r) => r === undefined).length;
          if (stillUndefined === 0) {
            // Stage 3: 2-of-3 consensus on Available results
            if (this.consensusConfig !== undefined) {
              return await this.#applyConsensusCheck(retried, domains, signal);
            }
            return retried;
          }
          return this.#perDomainFallback(retried, domains, signal);
        }
      }
      return this.#perDomainFallback(results, domains, signal);
    }

    // Stage 3: 2-of-3 consensus on Available results
    if (this.consensusConfig !== undefined) {
      return await this.#applyConsensusCheck(results, domains, signal);
    }

    return results;
  }

  /**
   * 2-of-3 resolver consensus check: for each domain that passed the primary
   * check as Available, query a secondary (independent) DNS provider.
   * If the secondary disagrees (Registered), mark the domain as Unknown
   * (conservative: when resolvers disagree, do not pass).
   */
  async #applyConsensusCheck(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<(DnsCheckResult | undefined)[]> {
    if (signal?.aborted) return results;
    const cfg = this.consensusConfig!;
    const tldSet = cfg.requiredTlds !== undefined ? new Set(cfg.requiredTlds) : undefined;

    const toVerify: Array<{ index: number; domain: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r === undefined) continue;
      if (r.status !== DomainStatus.Available) continue;
      if (tldSet !== undefined) {
        const tld = domains[i]?.tld;
        if (tld !== undefined && !tldSet.has(tld)) continue;
      }
      toVerify.push({ index: i, domain: r.domain });
    }

    if (toVerify.length === 0) return results;

    logger.info(
      { verifyCount: toVerify.length, totalAvailable: toVerify.length },
      'DNS: 2-of-3 consensus check on Available domains',
    );

    // Batch-verify with concurrency control
    let verified = 0;
    let disagreed = 0;
    for (let i = 0; i < toVerify.length; i += this.fallbackConcurrency) {
      if (signal?.aborted) return results;
      const batch = toVerify.slice(i, i + this.fallbackConcurrency);
      const batchResults = await Promise.all(
        batch.map(async ({ index, domain }) => {
          try {
            const secondary = await cfg.secondaryProvider.checkAvailability(domain, signal);
            return { index, domain, secondary };
          } catch {
            return { index, domain, secondary: undefined as DnsCheckResult | undefined };
          }
        }),
      );

      for (const { index, secondary } of batchResults) {
        if (secondary === undefined) continue;
        if (secondary.status === DomainStatus.Registered) {
          // Resolver disagreement: primary says Available, secondary says Registered
          disagreed++;
          results[index] = {
            domain: domains[index]!.domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
          logger.warn(
            { domain: domains[index]!.domain },
            'DNS: 2-of-3 consensus disagreement — primary Available, secondary Registered',
          );
        } else {
          verified++;
        }
      }
    }

    if (disagreed > 0) {
      logger.info({ verified, disagreed }, 'DNS: 2-of-3 consensus check complete');
    }

    return results;
  }

  /** Attempt the bulk DNS check. Returns [true, results] on full success,
   *  [false, null] on complete failure, [false, partial] on mismatch. */
  async #tryBulkCheck(
    domains: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<[boolean, (DnsCheckResult | undefined)[] | null]> {
    try {
      const results = await this.dnsProvider.checkBulk(
        domains.map((c) => c.domain),
        signal,
      );
      if (results.length === domains.length) return [true, results];
      logger.warn(
        { expected: domains.length, got: results.length },
        'DNS bulk check returned mismatched result count — falling back to per-domain checks',
      );
      return [false, results];
    } catch (err) {
      logger.warn({ err }, 'DNS bulk check threw — falling back to per-domain checks');
      return [false, null];
    }
  }

  /** Per-domain fallback with concurrency control. */
  async #perDomainFallback(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<(DnsCheckResult | undefined)[]> {
    for (let i = 0; i < domains.length; i += this.fallbackConcurrency) {
      if (signal?.aborted) return results;
      const batch = domains.slice(i, i + this.fallbackConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (c) => {
          try {
            return await this.dnsProvider.checkAvailability(c.domain, signal);
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

  /** Retry only the undefined entries from a bulk check result using
   *  individual checkAvailability calls. Returns null if the caller should
   *  fall through to the full per-domain fallback instead. */
  async #retryUndefinedBatch(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<(DnsCheckResult | undefined)[] | null> {
    const undefinedIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) undefinedIndices.push(i);
    }
    if (undefinedIndices.length === 0) return results;

    // Retry undefined domains individually with a short delay between batches
    // to avoid hammering the resolver again with the same batch.
    let retried = 0;
    for (let i = 0; i < undefinedIndices.length; i += this.fallbackConcurrency) {
      if (signal?.aborted) return null;
      const batch = undefinedIndices.slice(i, i + this.fallbackConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (idx) => {
          try {
            return await this.dnsProvider.checkAvailability(domains[idx]!.domain, signal);
          } catch {
            return undefined;
          }
        }),
      );
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result !== undefined) {
          results[batch[j]!] = result;
          retried++;
        }
      }
    }

    if (retried > 0) {
      logger.info(
        { retried, remainingUndefined: undefinedIndices.length - retried },
        'DNS cross-validation recovered some undefined results',
      );
    }

    return results;
  }
}
