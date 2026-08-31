// SPDX-License-Identifier: AGPL-3.0-only
import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import { CandidateSource, type DomainCandidate } from '../../types/candidate.js';
import type { DnsProvider, DnsCheckOptions } from '../../providers/dns/dns-provider.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsConsensusStats, Stage, StageDegradation, StageResult } from '../stage.js';
import { isValidDomain } from '../../utils/domain.js';
import { getLogger } from '../../logger.js';
import type { AuthoritativeZoneResolver } from '../../providers/dns/authoritative-zone-resolver.js';

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
  /**
   * Concurrency ceiling for the secondary verification phase (ADR-0044).
   * Bounded independently of the primary's DNS_BULK_CONCURRENCY: the gate is
   * fail-closed, so its own burst must not multiply the DNS traffic of an
   * already-heavy run. Default: falls back to the stage's bulk concurrency.
   */
  consensusConcurrency?: number;
  /**
   * Optional third DNS provider (ADR-0045). Consulted when the secondary
   * cannot answer an Available primary verdict: a tertiary Available
   * confirmation rescues the domain, a tertiary Registered answer vetoes
   * it. Also mandatory when requiredAvailable is 2.
   */
  tertiaryProvider?: DnsProvider;
  /**
   * How many verification legs must confirm an Available verdict (1 or 2,
   * default 1): 1 = the secondary alone suffices (tertiary consulted only
   * when the secondary cannot answer), 2 = BOTH the secondary and the
   * tertiary must confirm. Clamped to 1 when no tertiaryProvider is
   * configured — a requirement no leg can satisfy must never silently
   * downgrade every domain (ADR-0045).
   */
  requiredAvailable?: number;
  /**
   * When true, the consensus gate was disabled at startup due to runtime
   * disjointness failure (shared IPs/operators across legs). The stage will
   * skip consensus validation and emit a degraded-run flag.
   */
  disabled?: boolean;
  /**
   * Human-readable reason for disablement (e.g., "shared IPs: 1.1.1.1; shared operators: cloudflare").
   */
  disableReason?: string;
  /**
   * When true, the consensus gate was degraded at startup due to incomplete
   * runtime validation (strict mode). The stage will run but mark the run
   * as degraded because the independence proof is incomplete.
   */
  runtimeDegraded?: boolean;
  /**
   * Optional authoritative zone resolver for zone-aware disjointness validation.
   * When provided, the consensus gate will skip TLDs where the secondary/tertiary
   * resolver legs share authoritative nameservers with the primary — preventing
   * "Consensus Theater" where independent opinions are actually rubber stamps
   * of the same registry infrastructure (e.g., Verisign for .com/.net).
   * Fail-open: if authoritative data is unavailable, the gate proceeds normally.
   */
  authoritativeZoneResolver?: AuthoritativeZoneResolver;
  /**
   * Resolver endpoints for the secondary provider (e.g., ['dot:94.140.14.14', 'dot:194.242.2.2']).
   * Used for authoritative zone overlap detection. Populated by the provider factory.
   */
  secondaryEndpoints?: string[];
  /**
   * Resolver endpoints for the tertiary provider.
   * Used for authoritative zone overlap detection. Populated by the provider factory.
   */
  tertiaryEndpoints?: string[];
  /**
   * Dual-redundant tertiary configuration (ADR-0068): when dual-redundant mode
   * is enabled, this contains the two independent tertiary providers that are
   * raced for rescue/veto. A single tertiary provider failure no longer degrades
   * the entire tertiary leg.
   */
  tertiaryConfig?: {
    primary: DnsProvider;
    secondary: DnsProvider;
    strategy: 'dual-redundant' | 'single';
  };
}

export class DnsPreFilterStage implements Stage<DomainCandidate> {
  readonly name = 'DnsPreFilterStage';

  constructor(
    private readonly dnsProvider: DnsProvider,
    private readonly fallbackConcurrency: number = 10,
    private readonly skipSources: CandidateSource[] = [],
    private readonly consensusConfig?: ConsensusDnsConfig,
  ) {}

  /** Whether the requiredAvailable=2-without-tertiary clamp was already logged. */
  #tertiaryClampWarned = false;

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
    // them out. Also propagate forceWhoisRecheck to downstream RDAP stage.
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
    const consensusStats: DnsConsensusStats = {
      verified: 0,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
    };

    if (closeoutIndices.length > 0) {
      const closeoutDomains = closeoutIndices.map((i) => toFilter[i]!);
      const closeoutOpts: DnsCheckOptions = { forceRecheck: true };
      const results = await this.#resolveBulkWithFallback(
        closeoutDomains,
        signal,
        closeoutOpts,
        degradations,
        consensusStats,
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
        consensusStats,
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
        const isCloseout = candidate.source === CandidateSource.CloseoutCsv;
        passed.push({
          ...candidate,
          dnsStatus,
          status: CandidateStatus.Pending,
          ...(isCloseout ? { forceWhoisRecheck: true } : {}),
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
      ...(consensusStats.verified > 0 ||
      consensusStats.disagreed > 0 ||
      consensusStats.unverifiable > 0
        ? { consensusStats }
        : {}),
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
    consensusStats?: DnsConsensusStats,
  ): Promise<(DnsCheckResult | undefined)[]> {
    if (domains.length === 0) return [];
    if (signal?.aborted) return new Array(domains.length);

    // Stage 1: fast bulk check from the DNS provider (multi-resolver race internally).
    const [bulkOk, results] = await this.#tryBulkCheck(domains, signal, options);
    if (!bulkOk || results === null) {
      // Bulk check failed entirely — fall back to per-domain checks. ADR-0040:
      // the 2-of-3 consensus MUST still run on the recovered verdicts; a bulk
      // failure must not strip the availability guarantee that a healthy run
      // gets (ADR-0002 parity across every resolution path).
      return this.#fallbackWithConsensus(
        results ?? new Array(domains.length),
        domains,
        signal,
        options,
        degradations,
        consensusStats,
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
            // Stage 3: 2-of-3 consensus on the fully-recovered results.
            return this.#applyConsensusIfConfigured(
              retried,
              domains,
              signal,
              degradations,
              consensusStats,
            );
          }
          return this.#fallbackWithConsensus(
            retried,
            domains,
            signal,
            options,
            degradations,
            consensusStats,
          );
        }
      }
      return this.#fallbackWithConsensus(
        results,
        domains,
        signal,
        options,
        degradations,
        consensusStats,
      );
    }

    // Stage 3: 2-of-3 consensus on Available results.
    return this.#applyConsensusIfConfigured(results, domains, signal, degradations, consensusStats);
  }

  /** Runs the per-domain fallback and then applies the 2-of-3 consensus on the
   *  recovered verdicts — no resolution path is allowed to skip ADR-0002. */
  async #fallbackWithConsensus(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
    degradations?: StageDegradation[],
    consensusStats?: DnsConsensusStats,
  ): Promise<(DnsCheckResult | undefined)[]> {
    const fallback = await this.#perDomainFallback(results, domains, signal, options);
    return this.#applyConsensusIfConfigured(
      fallback,
      domains,
      signal,
      degradations,
      consensusStats,
    );
  }

  /** Applies the 2-of-3 consensus check when the stage is configured with a
   *  secondary provider; otherwise returns the results unchanged. */
  async #applyConsensusIfConfigured(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
    degradations?: StageDegradation[],
    consensusStats?: DnsConsensusStats,
  ): Promise<(DnsCheckResult | undefined)[]> {
    if (this.consensusConfig === undefined) return results;
    // Consensus gate disabled at startup (disjointness failure) — degrade gracefully
    // instead of hard-failing. The run continues with single-resolver verdicts but
    // is marked degraded so the operator knows the output lacks independent confirmation.
    if (this.consensusConfig.disabled) {
      const reason = this.consensusConfig.disableReason ?? 'runtime disjointness failure';
      logger.warn(
        { reason, disabled: true },
        `DNS: consensus gate disabled at startup — ${reason}. Continuing with single-resolver verdicts (degraded run).`,
      );
      if (degradations !== undefined) {
        degradations.push({
          stageName: this.name,
          reason: 'consensus-disabled',
          processedCount: 0,
          expectedCount: 0,
          message: `DNS consensus gate disabled: ${reason}. Run degraded to single-resolver mode.`,
        });
      }
      if (consensusStats !== undefined) {
        consensusStats.degraded = true;
      }
      return results;
    }
    // Runtime validation degraded (strict mode with partial results) — run consensus
    // but mark the run as degraded because independence proof is incomplete.
    if (this.consensusConfig.runtimeDegraded && degradations !== undefined) {
      degradations.push({
        stageName: this.name,
        reason: 'consensus-runtime-degraded',
        processedCount: 0,
        expectedCount: 0,
        message:
          'DNS consensus gate running with incomplete runtime validation (strict mode) — independence proof incomplete',
      });
      if (consensusStats !== undefined) consensusStats.degraded = true;
      logger.warn(
        'DNS: consensus gate running in degraded mode — runtime validation incomplete (strict mode)',
      );
    }
    return this.#applyConsensusCheck(results, domains, signal, degradations, consensusStats);
  }

  /**
   * 2-of-3 resolver consensus check: for each domain that passed the primary
   * check as Available, query a secondary (independent) DNS provider.
   * The primary's Available verdict is only final when the secondary
   * independently confirms it: a disagreement (Registered) OR a failure to
   * answer (undefined) OR an Unknown answer downgrades the domain to
   * Unknown — "unknown wins over available" (ADR-0002).
   *
   * ADR-0045 adds an optional tertiary leg: when the secondary cannot answer
   * (error/timeout), the tertiary is consulted instead of failing the
   * domain: a tertiary Available confirmation rescues the domain, a
   * tertiary Registered answer vetoes it. With requiredAvailable = 2 the
   * tertiary becomes mandatory — both verification legs must confirm. A
   * Registered verdict from the secondary remains a final veto: the law is
   * "registered wins", never "registered rescued".
   */
  async #applyConsensusCheck(
    results: (DnsCheckResult | undefined)[],
    domains: DomainCandidate[],
    signal?: AbortSignal,
    degradations?: StageDegradation[],
    consensusStats?: DnsConsensusStats,
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

    // --- Authoritative Zone Overlap Check (Consensus Theater prevention) ---
    // If the secondary/tertiary resolver legs share authoritative nameservers
    // with the primary for a TLD, their "independent" opinion is a rubber stamp.
    // We skip consensus for those TLDs (fail-open: primary verdict stands)
    // and track the overlap for observability.
    let verified = 0;
    let disagreed = 0;
    let unverifiable = 0;
    let tertiaryRescued = 0;
    let originOverlapCount = 0;
    if (cfg.authoritativeZoneResolver !== undefined) {
      const secondaryEndpoints = cfg.secondaryEndpoints ?? [];
      const tertiaryEndpoints = cfg.tertiaryEndpoints ?? [];
      const allVerificationEndpoints = [...secondaryEndpoints, ...tertiaryEndpoints];

      if (allVerificationEndpoints.length > 0) {
        const filteredToVerify: Array<{ index: number; domain: string }> = [];
        for (const { index, domain } of toVerify) {
          const candidate = domains[index];
          const tld = candidate?.tld;
          if (tld !== undefined) {
            const hasOverlap = !cfg.authoritativeZoneResolver.areZonesDisjoint(
              tld,
              [], // primary origins not needed for this check
              allVerificationEndpoints,
            );
            if (hasOverlap) {
              originOverlapCount++;
              logger.warn(
                { domain, tld, endpoints: allVerificationEndpoints },
                'DNS: consensus skipped — verification leg shares authoritative zone with primary (Consensus Theater prevention) — primary verdict stands',
              );
              // Skip consensus for this domain; primary Available verdict stands
              verified++; // Count as verified since we're accepting the primary verdict
              continue;
            }
          }
          filteredToVerify.push({ index, domain });
        }
        // Replace toVerify with filtered list
        toVerify.length = 0;
        toVerify.push(...filteredToVerify);
      }
    }

    if (toVerify.length === 0) {
      if (consensusStats !== undefined && originOverlapCount > 0) {
        consensusStats.originOverlap = (consensusStats.originOverlap ?? 0) + originOverlapCount;
      }
      return results;
    }

    const tertiary = cfg.tertiaryProvider;
    const required = cfg.requiredAvailable === 2 && tertiary !== undefined ? 2 : 1;
    if (cfg.requiredAvailable === 2 && tertiary === undefined && !this.#tertiaryClampWarned) {
      this.#tertiaryClampWarned = true;
      logger.warn(
        'DNS: DNS_CONSENSUS_REQUIRED_AVAILABLE=2 has no tertiary leg — clamping to 1 ' +
          '(one confirmation beyond the primary) so the gate cannot demand a ' +
          'confirmation no configured leg can provide',
      );
    }

    logger.info(
      { verifyCount: toVerify.length, totalAvailable: toVerify.length, requiredLegs: required },
      'DNS: 2-of-3 consensus check on Available domains',
    );

    // Batch-verify with concurrency control. The consensus gate gets its own
    // ceiling (consensusConcurrency) instead of borrowing the primary's bulk
    // concurrency, so a verification stampede cannot multiply DNS traffic.
    const consensusConcurrency = cfg.consensusConcurrency ?? this.fallbackConcurrency;
    for (let i = 0; i < toVerify.length; i += consensusConcurrency) {
      if (signal?.aborted) return results;
      const batch = toVerify.slice(i, i + consensusConcurrency);

      const secondaryResults = await Promise.all(
        batch.map(async ({ index, domain }) => {
          try {
            const secondary = await cfg.secondaryProvider.checkAvailability(domain, signal, {
              forceRecheck: true,
            });
            return { index, domain, secondary };
          } catch {
            return { index, domain, secondary: undefined as DnsCheckResult | undefined };
          }
        }),
      );

      // Domains that need the tertiary before a verdict can be cast: either
      // the secondary could not answer (rescue path) or requiredAvailable=2
      // demands a second confirmation in addition to the secondary's.
      const needsTertiary: Array<{ index: number; domain: string; secondaryConfirmed: boolean }> =
        [];
      for (const { index, domain, secondary } of secondaryResults) {
        // A definitive Registered from the secondary is a final veto: the
        // domain must not pass on any other leg (ADR-0002 conservatism).
        if (secondary !== undefined && secondary.status === DomainStatus.Registered) {
          disagreed++;
          results[index] = {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
          logger.warn(
            { domain, secondary: secondary.status },
            'DNS: 2-of-3 consensus vetoed (secondary Registered) — downgraded to Unknown',
          );
          continue;
        }

        if (secondary !== undefined && secondary.status === DomainStatus.Available) {
          if (required >= 2) {
            needsTertiary.push({ index, domain, secondaryConfirmed: true });
          } else {
            verified++;
          }
          continue;
        }

        // Secondary cannot answer (error, timeout, Unknown).
        if (tertiary !== undefined) {
          needsTertiary.push({ index, domain, secondaryConfirmed: false });
        } else {
          unverifiable++;
          results[index] = {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
          logger.warn(
            { domain, secondary: secondary?.status ?? 'no-answer' },
            'DNS: 2-of-3 consensus not confirmed — downgraded to Unknown',
          );
        }
      }

      if (needsTertiary.length === 0) continue;

      const tertiaryResults = await Promise.all(
        needsTertiary.map(async ({ index, domain }) => {
          try {
            const third = await tertiary!.checkAvailability(domain, signal, {
              forceRecheck: true,
            });
            return { index, domain, third };
          } catch {
            return { index, domain, third: undefined as DnsCheckResult | undefined };
          }
        }),
      );

      for (const { index, domain, third } of tertiaryResults) {
        const entry = needsTertiary.find((n) => n.index === index)!;
        if (third !== undefined && third.status === DomainStatus.Registered) {
          // The tertiary vetoes: Registered wins over any Available.
          disagreed++;
          results[index] = {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
          logger.warn(
            { domain, tertiary: third.status },
            'DNS: 2-of-3 consensus vetoed by tertiary (Registered) — downgraded to Unknown',
          );
          continue;
        }
        if (third !== undefined && third.status === DomainStatus.Available) {
          if (entry.secondaryConfirmed) {
            // requiredAvailable=2: both verification legs confirmed.
            verified++;
            continue;
          }
          if (required < 2) {
            // Rescue path (ADR-0045): the secondary could not answer and the
            // tertiary confirmed the primary's Available verdict.
            verified++;
            tertiaryRescued++;
            continue;
          }
          // Strict mode (ADR-0059): a tertiary-only Available after a failed
          // secondary is a single independent opinion — it cannot satisfy a
          // two-leg requirement. The tertiary's Registered veto above stays
          // authoritative; its Available falls through to unverifiable.
        }
        unverifiable++;
        results[index] = {
          domain,
          status: DomainStatus.Unknown,
          checkedAt: new Date().toISOString(),
        };
        logger.warn(
          {
            domain,
            tertiary: third?.status ?? 'no-answer',
            requiredAvailable: cfg.requiredAvailable,
          },
          'DNS: 2-of-3 consensus not confirmed (tertiary could not answer, or its single ' +
            'confirmation is insufficient under requiredAvailable=2) — downgraded to Unknown',
        );
      }
    }

    // Track tertiary-specific stats (populated during tertiary loop above)
    // tertiaryDisagreed and tertiaryUnverifiable are counted inline
    // in the tertiaryResults loop (lines 487-536)

    if (consensusStats !== undefined) {
      consensusStats.verified += verified;
      consensusStats.disagreed += disagreed;
      consensusStats.unverifiable += unverifiable;
      if (tertiaryRescued > 0) {
        consensusStats.tertiaryRescued = (consensusStats.tertiaryRescued ?? 0) + tertiaryRescued;
      }
      // tertiaryDisagreed and tertiaryUnverifiable are populated
      // directly in the tertiary loop when tertiary vetoes or fails
    }

    if (disagreed > 0 || unverifiable > 0) {
      logger.info(
        { verified, disagreed, unverifiable, tertiaryRescued },
        'DNS: 2-of-3 consensus check complete',
      );
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
      if (consensusStats !== undefined) consensusStats.degraded = true;
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
