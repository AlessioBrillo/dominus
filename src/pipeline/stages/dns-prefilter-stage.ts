// SPDX-License-Identifier: AGPL-3.0-only
import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import { CandidateSource, type DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider, DnsCheckOptions } from '../../providers/dns/dns-provider.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { Stage, StageResult, StageDegradation } from '../stage.js';
import { isValidDomain } from '../../utils/domain.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface ConsensusDnsConfig {
  /** Second DNS provider for cross-validation (e.g., using a different resolver group). */
  secondaryProvider: DnsProvider;
  /** TLDs requiring cross-validation. Default: all TLDs. */
  requiredTlds?: string[];
  /**
   * Fraction of consensus-verified domains that may be unverifiable before the
   * run is flagged degraded. Default: 0.5 (half). A run where the secondary
   * cannot confirm more than this share of primary-Available domains is
   * degraded, because the verdicts downstream rest on a single resolver.
   */
  degradedRatio?: number;
  /**
   * Minimum number of consensus-verified domains before a degradation is
   * flagged. Small runs must not flag the pipeline on one bad resolver.
   * Default: 10.
   */
  degradedMin?: number;
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

    // Separate closeout sources — they need forceRecheck to bypass the
    // persistent DNS cache and always get a live result, since they are
    // in a transitional state (aftermarket/expiring) where a stale
    // "Registered" cache entry from 7 days ago would incorrectly filter
    // them out.
    const closeoutIndices: number[] = [];
    const otherIndices: number[] = [];
    for (let i = 0; i < toFilter.length; i++) {
      if (toFilter[i]!.source === CandidateSource.CloseoutCsv) {
        closeoutIndices.push(i);
      } else {
        otherIndices.push(i);
      }
    }

    const perDomainResults: (DnsCheckResult | undefined)[] = new Array(toFilter.length);
    const degradations: StageDegradation[] = [];

    if (closeoutIndices.length > 0) {
      const closeoutDomains = closeoutIndices.map((i) => toFilter[i]!);
      const closeoutOpts: DnsCheckOptions = { forceRecheck: true };
      const results = await this.#resolveBulkWithFallback(
        closeoutDomains,
        signal,
        closeoutOpts,
        degradations,
      );
      for (let j = 0; j < closeoutIndices.length; j++) {
        perDomainResults[closeoutIndices[j]!] = results[j];
      }
    }

    if (otherIndices.length > 0) {
      const otherDomains = otherIndices.map((i) => toFilter[i]!);
      const results = await this.#resolveBulkWithFallback(
        otherDomains,
        signal,
        undefined,
        degradations,
      );
      for (let j = 0; j < otherIndices.length; j++) {
        perDomainResults[otherIndices[j]!] = results[j];
      }
    }

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

    return {
      passed,
      filtered,
      stageName: this.name,
      durationMs: Date.now() - start,
      ...(degradations.length > 0 ? { degradations } : {}),
    };
  }

  /** Threshold fraction of undefined results that triggers a cross-validation retry. */
  static readonly #CROSS_VALIDATE_UNDEFINED_THRESHOLD = 0.1;

  /** Default fraction of consensus-verified domains that may stay unverifiable
   *  before the run is flagged degraded (see ADR-0039). */
  static readonly #DEFAULT_DEGRADED_RATIO = 0.5;

  /** Default minimum consensus-verified domains before degradation is flagged. */
  static readonly #DEFAULT_DEGRADED_MIN = 10;

  async #resolveBulkWithFallback(
    domains: DomainCandidate[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
    degradations?: StageDegradation[],
  ): Promise<(DnsCheckResult | undefined)[]> {
    if (domains.length === 0) return [];
    if (signal?.aborted) return new Array(domains.length);

    // Stage 1: fast bulk check from the DNS provider (multi-resolver race internally).
    const [bulkOk, results] = await this.#tryBulkCheck(domains, signal, options);
    if (!bulkOk || results === null) {
      return this.#perDomainFallback(
        results ?? new Array(domains.length),
        domains,
        signal,
        options,
      );
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
        const retried = await this.#retryUndefinedBatch(results, domains, signal, options);
        if (retried !== null) {
          const stillUndefined = retried.filter((r) => r === undefined).length;
          if (stillUndefined === 0) {
            // Stage 3: 2-of-3 consensus on Available results
            if (this.consensusConfig !== undefined) {
              return await this.#applyConsensusCheck(retried, domains, signal, degradations);
            }
            return retried;
          }
          return this.#perDomainFallback(retried, domains, signal, options);
        }
      }
      return this.#perDomainFallback(results, domains, signal, options);
    }

    // Stage 3: 2-of-3 consensus on Available results
    if (this.consensusConfig !== undefined) {
      return await this.#applyConsensusCheck(results, domains, signal, degradations);
    }

    return results;
  }

  /**
   * 2-of-3 resolver consensus check: for each domain that passed the primary
   * check as Available, query a secondary (independent) DNS provider.
   * The primary's Available verdict is only final when the secondary
   * independently confirms it: a disagreement (Registered) OR a failure to
   * answer (undefined) OR an Unknown answer downgrades the domain to
   * Unknown — "unknown wins over available" (ADR-0002).
   */
  async #applyConsensusCheck(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
    degradations?: StageDegradation[],
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
    let unverifiable = 0;
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

      for (const { index, domain, secondary } of batchResults) {
        // Strict 2-of-3 consensus: only an explicit Available from the
        // secondary confirms the primary's verdict. A non-answer (thrown
        // error or undefined) and an Unknown answer are treated the same
        // as a disagreement — the domain must not pass on a single
        // resolver's opinion (ADR-0002 conservatism).
        if (secondary === undefined || secondary.status !== DomainStatus.Available) {
          if (secondary?.status === DomainStatus.Registered) disagreed++;
          else unverifiable++;
          results[index] = {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
          logger.warn(
            {
              domain,
              secondary: secondary?.status ?? 'no-answer',
            },
            'DNS: 2-of-3 consensus not confirmed — downgraded to Unknown',
          );
        } else {
          verified++;
        }
      }
    }

    if (disagreed > 0 || unverifiable > 0) {
      logger.info({ verified, disagreed, unverifiable }, 'DNS: 2-of-3 consensus check complete');
    }

    // Fail-closed with a visible flag: when the secondary cannot confirm the
    // majority of primary-Available verdicts, the run continues (domains are
    // downgraded to Unknown and filtered) but the pipeline is marked degraded
    // so the caller knows the output rests on a single resolver. Small runs
    // below degradedMin never flag (one bad resolver must not poison a short
    // run). See ADR-0039.
    const consensusTotal = verified + disagreed + unverifiable;
    const degradedRatio = cfg.degradedRatio ?? DnsPreFilterStage.#DEFAULT_DEGRADED_RATIO;
    const degradedMin = cfg.degradedMin ?? DnsPreFilterStage.#DEFAULT_DEGRADED_MIN;
    if (
      consensusTotal >= degradedMin &&
      unverifiable / consensusTotal >= degradedRatio &&
      degradations !== undefined
    ) {
      degradations.push({
        stageName: this.name,
        reason: 'consensus-unverified',
        processedCount: verified,
        expectedCount: consensusTotal,
        message: `${unverifiable}/${consensusTotal} Available verdicts unconfirmed by the secondary provider`,
      });
      logger.warn(
        {
          verified,
          disagreed,
          unverifiable,
          consensusTotal,
          degradedRatio,
          degradedMin,
        },
        'DNS: consensus degraded — secondary could not verify the majority of Available domains',
      );
    }

    return results;
  }

  /** Attempt the bulk DNS check. Returns [true, results] on full success,
   *  [false, null] on complete failure, [false, partial] on mismatch. */
  async #tryBulkCheck(
    domains: DomainCandidate[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<[boolean, (DnsCheckResult | undefined)[] | null]> {
    try {
      const results = await this.dnsProvider.checkBulk(
        domains.map((c) => c.domain),
        signal,
        options,
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
    options?: DnsCheckOptions,
  ): Promise<(DnsCheckResult | undefined)[]> {
    for (let i = 0; i < domains.length; i += this.fallbackConcurrency) {
      if (signal?.aborted) return results;
      const batch = domains.slice(i, i + this.fallbackConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (c) => {
          try {
            return await this.dnsProvider.checkAvailability(c.domain, signal, options);
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
    options?: DnsCheckOptions,
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
            return await this.dnsProvider.checkAvailability(domains[idx]!.domain, signal, options);
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
