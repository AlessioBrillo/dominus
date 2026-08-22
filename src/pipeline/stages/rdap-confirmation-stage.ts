// SPDX-License-Identifier: AGPL-3.0-only
import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import { toBatches } from '../../utils/array.js';
import type { DomainCandidate, WhoisMeta } from '../../types/candidate.js';
import { CandidateSource } from '../../types/candidate.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { WhoisProvider, WhoisResult } from '../../providers/whois/whois-provider.js';
import type { RdapConsensusStats, Stage, StageDegradation, StageResult } from '../stage.js';
import {
  hasAuthoritativeOriginOverlap,
  hasWinningOriginOverlap,
  rdapUrlOrigin,
} from '../../providers/rdap/rdap-consensus-validator.js';
import { getLogger } from '../../logger.js';

const DEFAULT_ENRICH_TIMEOUT_MS = 10_000;

/** Default WHOIS budget: WHOIS is a bounded enrichment over the authoritative
 *  RDAP answer (ADR-0035). A WHOIS response slower than this is discarded and
 *  RDAP decides. */
const DEFAULT_WHOIS_BUDGET_MS = 1_000;

interface AvailabilityResult {
  domain: string;
  status: DomainStatus;
  isPremium: boolean;
  registrar?: string | undefined;
  expiresAt?: string | undefined;
  createdDate?: string | undefined;
  domainAge?: number | undefined;
  checkedAt: string;
  source: 'rdap' | 'whois' | 'cross-validated';
  /** Origin of the RDAP server that produced the verdict (consensus
   *  rubber-stamp detection, ADR-0050). Undefined for WHOIS-only paths. */
  sourceOrigin?: string | undefined;
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
    sourceOrigin: r.sourceOrigin,
  };
}

function whoisToResult(r: WhoisResult): AvailabilityResult {
  let domainAge: number | undefined;
  if (r.createdDate !== undefined) {
    const created = new Date(r.createdDate);
    domainAge = Math.max(0, (Date.now() - created.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  }
  return {
    domain: r.domain,
    status: r.available ? DomainStatus.Available : DomainStatus.Registered,
    isPremium: false,
    registrar: r.registrar,
    expiresAt: r.expiryDate,
    createdDate: r.createdDate,
    domainAge,
    checkedAt: r.checkedAt,
    source: 'whois',
  };
}

function buildWhoisMeta(result: AvailabilityResult): WhoisMeta | undefined {
  const meta: WhoisMeta = {};
  if (result.domainAge !== undefined) meta.domainAge = result.domainAge;
  if (result.registrar !== undefined) meta.registrar = result.registrar;
  if (result.createdDate !== undefined) meta.createdDate = result.createdDate;
  if (result.expiresAt !== undefined) meta.expiryDate = result.expiresAt;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export interface RdapConsensusConfig {
  /** Dedicated second RDAP provider on an independent origin (ADR-0050). */
  secondaryProvider: RdapProvider;
  /** Endpoint origin of the second leg, for diagnostics. */
  secondaryOrigin: string;
  /**
   * Fraction of consensus-confirmed Available domains that may be
   * unverifiable before the run is flagged degraded. Default: 0.5.
   */
  degradedRatio?: number;
  /** Minimum consensus-confirmed domains before a degradation is flagged. Default: 10. */
  degradedMin?: number;
  /**
   * Concurrency ceiling for the verification phase (ADR-0050 §4).
   * Bounded independently of RDAP_BATCH_CONCURRENCY so a verification
   * stampede cannot multiply registry traffic.
   */
  consensusConcurrency?: number;
  /**
   * Opt-in WHOIS rescue leg (ADR-0051): when the second RDAP leg cannot
   * answer, the verdict is re-checked through WHOIS within the same bounded
   * budget as the stage's enrichment race. False by default — fail-closed.
   */
  rescueWhoisEnabled?: boolean;
  /**
   * Per-TLD forced WHOIS rescue (ADR-0051 extension): for TLDs in this set,
   * WHOIS rescue is attempted even when rescueWhoisEnabled is false.
   * Targets ccTLDs with historically unstable RDAP (e.g., .it, .de, .jp, .br).
   */
  rescueWhoisTlds?: Set<string>;
  /**
   * Per-TLD authoritative origin resolver (ADR-0058): returns the origins
   * that are authoritative for a TLD (IANA bootstrap, rdap.org excluded —
   * it doubles as the default second leg). When configured, the stage skips
   * the second leg and counts the verdict as originOverlap whenever the
   * second endpoint's origin is authoritative for the candidate's TLD: the
   * 2-of-2 would be a rubber stamp. Unset disables the runtime guard.
   *
   * Fail-closed by default (ADR-0060): a resolver rejection downgrades the
   * verdict as unverifiable (originGuardUnavailable) instead of consulting
   * a second leg that might overlap the TLD's authoritative origins.
   *
   * A second, unconditional rubber-stamp guard runs regardless: when the
   * origin that served the primary verdict equals the second leg origin
   * (e.g. rdap.org winning the primary race AND being the second leg), the
   * second opinion is skipped and counted as originOverlap (ADR-0050).
   */
  tldOriginsResolver?: (tld: string) => Promise<string[]>;
}

/** Default fraction of unverifiable Available domains that flags a run degraded. */
const DEFAULT_CONSENSUS_DEGRADED_RATIO = 0.5;
/** Default minimum consensus-confirmed domains before degradation counts. */
const DEFAULT_CONSENSUS_DEGRADED_MIN = 10;
/** Default concurrency ceiling for the consensus verification phase. */
const DEFAULT_CONSENSUS_CONCURRENCY = 10;

export class RdapConfirmationStage implements Stage<DomainCandidate> {
  readonly name = 'RdapConfirmationStage';

  constructor(
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider?: WhoisProvider,
    private readonly concurrency: number = 10,
    private readonly enrichTimeoutMs: number = DEFAULT_ENRICH_TIMEOUT_MS,
    /** Maximum time a WHOIS answer may take before it is discarded. RDAP is
     *  authoritative (ADR-0035): within the budget a WHOIS disagreement still
     *  blocks conservatively, beyond the budget RDAP decides. */
    private readonly whoisBudgetMs: number = DEFAULT_WHOIS_BUDGET_MS,
    /**
     * Provider that bypasses the persistent RDAP cache (live lookup that
     * still refreshes the entry). Used for closeout candidates, which are in
     * a transitional state (aftermarket/expiring): a stale cached
     * "Available"/"Registered" verdict would otherwise gate their run,
     * mirroring the DNS stage's forceRecheck for closeout sources.
     */
    private readonly freshRdapProvider?: RdapProvider,
    /**
     * Optional 2-of-2 consensus gate (ADR-0050): every Available verdict is
     * re-confirmed by an independent second provider. Fail-closed — a
     * disagreement or unverifiable confirmation downgrades the candidate.
     */
    private readonly consensusConfig?: RdapConsensusConfig,
  ) {}

  async process(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };

    let passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];
    // Origin that served each primary verdict (RdapResult.sourceOrigin) —
    // the consensus gate compares it against the second leg endpoint to
    // catch the same-server rubber stamp (ADR-0050).
    const winningOrigins = new Map<string, string>();

    const batches = toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          try {
            const result = await this.#checkAvailability(candidate, signal);
            return { candidate, result, error: undefined } as const;
          } catch (error) {
            return { candidate, result: undefined, error } as const;
          }
        }),
      );
      for (const settled of results) {
        if (settled.status === 'rejected') continue;
        const { candidate, result, error } = settled.value;
        if (error !== undefined) {
          filtered.push({
            ...candidate,
            rdapStatus: 'error',
            status: CandidateStatus.RdapFiltered,
          });
          continue;
        }
        if (result!.sourceOrigin !== undefined) {
          winningOrigins.set(candidate.domain, result!.sourceOrigin);
        }
        if (result!.status === DomainStatus.Available && !result!.isPremium) {
          const rdapMeta = buildWhoisMeta(result!);
          const merged = {
            ...rdapMeta,
            ...candidate.whoisMeta,
            ...(candidate.closeoutMeta?.domainAge !== undefined
              ? { domainAge: candidate.closeoutMeta.domainAge }
              : {}),
          };
          const whoisMeta = Object.keys(merged).length > 0 ? merged : undefined;
          passed.push({
            ...candidate,
            rdapStatus: result!.status,
            isPremium: false,
            status: CandidateStatus.Pending,
            whoisMeta,
          });
        } else {
          filtered.push({
            ...candidate,
            rdapStatus: result!.status,
            isPremium: result!.isPremium,
            status: CandidateStatus.RdapFiltered,
          });
        }
      }
    }

    // 2-of-2 consensus (ADR-0050): every primary-Available verdict must be
    // independently confirmed by the second provider. Fail-closed — a
    // disagreement or an unverifiable answer downgrades the candidate. The
    // gate covers BOTH provider paths (cached and fresh closeout lookups):
    // it runs on the stage's outcome, not inside a single provider.
    const rdapConsensusStats: RdapConsensusStats | undefined = this.consensusConfig
      ? { verified: 0, disagreed: 0, unverifiable: 0, degraded: false }
      : undefined;
    if (this.consensusConfig !== undefined && passed.length > 0) {
      const degradations: StageDegradation[] = [];
      passed = await this.#verifyConsensus(
        passed,
        filtered,
        signal,
        rdapConsensusStats!,
        degradations,
        winningOrigins,
      );
      const result: StageResult<DomainCandidate> = {
        passed,
        filtered,
        stageName: this.name,
        durationMs: Date.now() - start,
        ...(rdapConsensusStats ? { rdapConsensusStats } : {}),
      };
      if (degradations.length > 0) result.degradations = degradations;
      return result;
    }

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }

  /**
   * Re-confirms every primary-Available verdict on the dedicated second leg
   * (ADR-0050). A definitive Registered (or premium) answer from the second
   * provider vetoes the domain — "registered wins", ADR-0002 conservatism,
   * mirroring the DNS secondary veto (ADR-0045): the outcome is never
   * Available. A failure to answer (error/timeout/Unknown) downgrades to
   * Unknown as well: the gate is fail-closed and never lets a single-leg
   * Available pass. The second leg is skipped (counted unverifiable) when
   * it would be a rubber stamp: its origin is authoritative for the TLD
   * (ADR-0058) or it is the same origin that served the primary verdict.
   * Returns the candidates that survived the gate.
   *
   * Runs under its own concurrency ceiling (RDAP_CONSENSUS_BULK_CONCURRENCY)
   * and flags the run degraded when the secondary cannot verify the majority
   * of a minimum sample, mirroring the DNS consensus-degradation policy
   * (ADR-0039).
   */
  async #verifyConsensus(
    passed: DomainCandidate[],
    filtered: DomainCandidate[],
    signal: AbortSignal | undefined,
    stats: RdapConsensusStats,
    degradations: StageDegradation[],
    winningOrigins: ReadonlyMap<string, string>,
  ): Promise<DomainCandidate[]> {
    const cfg = this.consensusConfig!;
    const logger = getLogger();
    const concurrency = cfg.consensusConcurrency ?? DEFAULT_CONSENSUS_CONCURRENCY;

    // Outcome per verified domain. Batches are re-checked in slices over the
    // original array; the survivors are re-assembled at the end.
    const survivor = new Set<string>();

    // ADR-0058 origin-overlap guard: per-TLD authoritative origins (IANA
    // bootstrap, rdap.org excluded upstream) resolved once per TLD per run.
    // In-flight resolutions are deduplicated so a parallel batch cannot
    // hammer the resolver for the same TLD.
    //
    // ADR-0060: a resolver failure is fail-closed, not fail-open. When the
    // guard cannot prove the second leg is disjoint from the TLD's
    // authoritative origins, the second opinion is never consulted (it could
    // be a rubber stamp served by an authoritative origin, e.g. rdap.org as
    // the default second leg) and the verdict is downgraded as unverifiable.
    // Only an explicitly unconfigured guard (or an unparsable secondary
    // endpoint — cannot prove overlap) keeps the previous consult-the-second-
    // leg behaviour.
    const secondaryOrigin = rdapUrlOrigin(cfg.secondaryOrigin);
    const authoritativeOriginsByTld = new Map<string, string[]>();
    const authoritativeOriginsInFlight = new Map<string, Promise<string[] | undefined>>();
    const resolveAuthoritativeOrigins = async (tld: string): Promise<string[] | undefined> => {
      if (cfg.tldOriginsResolver === undefined || secondaryOrigin === undefined) return undefined;
      const cached = authoritativeOriginsByTld.get(tld);
      if (cached !== undefined) return cached;
      const inFlight = authoritativeOriginsInFlight.get(tld);
      if (inFlight !== undefined) return inFlight;
      // An unresolved TLD resolves to an empty array (no overlap, second leg
      // consulted) — the same behaviour as a successful empty lookup. A
      // rejection is deliberately NOT caught here: it must propagate to the
      // per-candidate handler below, which downgrades the verdict (fail-
      // closed, ADR-0060) instead of consulting a possibly-overlapping leg.
      const pending = cfg
        .tldOriginsResolver(tld)
        .then((origins) => {
          authoritativeOriginsByTld.set(tld, origins);
          return origins;
        })
        .finally(() => {
          authoritativeOriginsInFlight.delete(tld);
        });
      authoritativeOriginsInFlight.set(tld, pending);
      return pending;
    };

    const batches = toBatches(passed, concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;
      const results = await Promise.all(
        batch.map(async (candidate) => {
          let authoritativeOrigins: string[] | undefined;
          try {
            authoritativeOrigins = await resolveAuthoritativeOrigins(candidate.tld);
          } catch (error) {
            // Fail-closed (ADR-0060): the guard could not rule out that the
            // second leg is an authoritative origin for the TLD. Consulting
            // it could rubber-stamp the primary verdict, so the second
            // opinion is skipped and the verdict downgraded.
            logger.warn(
              { error, tld: candidate.tld, domain: candidate.domain },
              'RDAP: authoritative origin lookup failed — second leg not consulted ' +
                '(fail-closed, ADR-0060)',
            );
            return { candidate, result: undefined, overlap: false, guardUnavailable: true };
          }
          try {
            const authoritativeOverlap =
              authoritativeOrigins !== undefined &&
              hasAuthoritativeOriginOverlap(authoritativeOrigins, cfg.secondaryOrigin);
            // The winner-origin guard is unconditional (needs no resolver):
            // when the primary race was won by the same origin as the
            // second leg, the second opinion would be a rubber stamp.
            const winnerOverlap = hasWinningOriginOverlap(
              winningOrigins.get(candidate.domain),
              cfg.secondaryOrigin,
            );
            if (authoritativeOverlap || winnerOverlap) {
              return { candidate, result: undefined, overlap: true, winnerOverlap };
            }
            const result = await cfg.secondaryProvider.confirm(candidate.domain, signal);
            return { candidate, result, overlap: false, winnerOverlap: false };
          } catch (error) {
            return { candidate, result: undefined, error, overlap: false, winnerOverlap: false };
          }
        }),
      );
      for (const { candidate, result, overlap, winnerOverlap, guardUnavailable } of results) {
        if (guardUnavailable === true) {
          stats.unverifiable++;
          stats.originGuardUnavailable = (stats.originGuardUnavailable ?? 0) + 1;
          continue;
        }
        if (overlap === true) {
          stats.unverifiable++;
          stats.originOverlap = (stats.originOverlap ?? 0) + 1;
          logger.warn(
            { domain: candidate.domain, origin: secondaryOrigin },
            winnerOverlap === true
              ? 'RDAP: 2-of-2 consensus skipped — the primary verdict was served by the ' +
                  'second leg origin (same server, rubber-stamp guard, ADR-0050) — ' +
                  'downgraded as unverifiable'
              : 'RDAP: 2-of-2 consensus skipped — the second leg origin is authoritative ' +
                  'for the candidate TLD (rubber-stamp guard, ADR-0058) — downgraded as ' +
                  'unverifiable',
          );
          continue;
        }
        if (result === undefined) {
          // WHOIS rescue leg (ADR-0051): the opt-in re-check runs when
          // the second RDAP leg could not answer. A definitive Registered is
          // never re-litigated — "registered wins" (ADR-0002). WHOIS
          // "available" confirms the verdict, WHOIS "registered" vetoes it,
          // and a WHOIS failure stays unverifiable (fail-closed, unchanged).
          // Per-TLD forced rescue (ADR-0051 extension): for TLDs in rescueWhoisTlds,
          // rescue is attempted even when rescueWhoisEnabled is false.
          const forceRescue = cfg.rescueWhoisTlds?.has(candidate.tld.toLowerCase()) === true;
          if (
            (cfg.rescueWhoisEnabled === true || forceRescue) &&
            this.whoisProvider !== undefined
          ) {
            const rescued = await this.#tryWhoisRescue(candidate);
            if (rescued === true) {
              survivor.add(candidate.domain);
              stats.verified++;
              if (forceRescue) {
                stats.perTldRescued = (stats.perTldRescued ?? 0) + 1;
              } else {
                stats.whoisRescued = (stats.whoisRescued ?? 0) + 1;
              }
              continue;
            }
            if (rescued === false) {
              stats.disagreed++;
              logger.warn(
                { domain: candidate.domain, forced: forceRescue },
                forceRescue
                  ? 'RDAP: 2-of-2 consensus vetoed by per-TLD WHOIS rescue leg (registered) — downgraded'
                  : 'RDAP: 2-of-2 consensus vetoed by WHOIS rescue leg (registered) — downgraded',
              );
              continue;
            }
          }
          stats.unverifiable++;
          continue;
        }
        if (result.status === DomainStatus.Available && !result.isPremium) {
          survivor.add(candidate.domain);
          stats.verified++;
          continue;
        }
        if (result.status === DomainStatus.Registered || result.isPremium) {
          stats.disagreed++;
          logger.warn(
            {
              domain: candidate.domain,
              secondStatus: result.status,
              isPremium: result.isPremium,
            },
            'RDAP: 2-of-2 consensus vetoed (second leg says registered) — downgraded',
          );
          continue;
        }
        stats.unverifiable++;
      }
    }

    // Fail-closed with a visible flag (ADR-0039 pattern): when the second leg
    // cannot verify the majority of a minimum sample of Available domains,
    // the run completes but is marked degraded so the caller knows the
    // verdicts downstream rest on a single provider. Small runs never flag.
    const consensusTotal = stats.verified + stats.disagreed + stats.unverifiable;
    const degradedRatio = cfg.degradedRatio ?? DEFAULT_CONSENSUS_DEGRADED_RATIO;
    const degradedMin = cfg.degradedMin ?? DEFAULT_CONSENSUS_DEGRADED_MIN;
    if (
      consensusTotal >= degradedMin &&
      stats.unverifiable / consensusTotal >= degradedRatio &&
      degradations !== undefined
    ) {
      stats.degraded = true;
      degradations.push({
        stageName: this.name,
        reason: 'consensus-unverified',
        processedCount: stats.verified,
        expectedCount: consensusTotal,
        message: `${stats.unverifiable}/${consensusTotal} Available verdicts unconfirmed by the second RDAP provider`,
      });
      logger.warn(
        { verified: stats.verified, unverifiable: stats.unverifiable, consensusTotal },
        'RDAP: consensus degraded — second provider could not verify the majority of Available domains',
      );
    }

    const remaining: DomainCandidate[] = [];
    for (const candidate of passed) {
      if (survivor.has(candidate.domain)) {
        remaining.push(candidate);
        continue;
      }
      // Fail-closed (ADR-0050): both a definitive veto and a failure to
      // verify downgrade the candidate to Unknown — never Available.
      filtered.push({
        ...candidate,
        rdapStatus: DomainStatus.Unknown,
        isPremium: false,
        status: CandidateStatus.RdapFiltered,
      });
    }
    return remaining;
  }

  /**
   * WHOIS rescue leg for the 2-of-2 consensus gate (ADR-0051): re-checks a
   * verdict the second RDAP leg could not confirm, through the WHOIS channel
   * within the same bounded budget as the stage's enrichment race. Returns
   * true when WHOIS confirms Available (rescued), false when WHOIS says
   * registered (veto — "registered wins", ADR-0002), and undefined when the
   * WHOIS answer is unavailable or late (stays unverifiable, fail-closed).
   */
  async #tryWhoisRescue(candidate: DomainCandidate): Promise<boolean | undefined> {
    const budgetSignal = AbortSignal.any([AbortSignal.timeout(this.whoisBudgetMs)]);
    try {
      const result = await Promise.race([
        this.whoisProvider!.checkAvailability(candidate.domain, budgetSignal).catch(
          () => undefined,
        ),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), this.whoisBudgetMs).unref(),
        ),
      ]);
      if (result === undefined) return undefined;
      return result.available ? true : false;
    } catch {
      return undefined;
    }
  }

  /** Closeout candidates always hit the fresh provider (cache-bypassing live
   *  lookup): they are in a transitional state where a stale cached verdict
   *  would wrongly gate them. Mirror of the DNS stage's closeout forceRecheck. */
  rdapProviderFor(candidate: DomainCandidate): RdapProvider {
    if (candidate.source === CandidateSource.CloseoutCsv && this.freshRdapProvider !== undefined) {
      return this.freshRdapProvider;
    }
    return this.rdapProvider;
  }

  async #checkAvailability(
    candidate: DomainCandidate,
    signal?: AbortSignal,
  ): Promise<AvailabilityResult> {
    const domain = candidate.domain;
    const timeoutSignal = AbortSignal.timeout(this.enrichTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    if (this.whoisProvider === undefined) {
      const rdap = await this.rdapProviderFor(candidate).confirm(domain, combined);
      return rdapToResult(rdap);
    }

    // WHOIS is bounded: a response that does not arrive within whoisBudgetMs
    // is discarded and RDAP is authoritative (ADR-0035). The race guarantees
    // the budget even if the WHOIS provider is not abort-aware.
    let whois: WhoisResult | undefined;
    try {
      const whoisBudgetSignal = AbortSignal.any([
        combined,
        AbortSignal.timeout(this.whoisBudgetMs),
      ]);
      whois = await Promise.race([
        this.whoisProvider.checkAvailability(domain, whoisBudgetSignal).catch(() => undefined),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), this.whoisBudgetMs).unref(),
        ),
      ]);
    } catch {
      whois = undefined;
    }

    let rdap: RdapResult | undefined;
    let rdapReason: unknown;
    try {
      rdap = await this.rdapProviderFor(candidate).confirm(domain, combined);
    } catch (error) {
      rdapReason = error;
    }

    if (rdap !== undefined && whois !== undefined) {
      return this.#crossValidate(domain, rdap, whois);
    }

    if (rdap !== undefined) {
      return rdapToResult(rdap);
    }

    if (whois !== undefined) {
      return whoisToResult(whois);
    }

    throw rdapReason;
  }

  #crossValidate(domain: string, rdap: RdapResult, whois: WhoisResult): AvailabilityResult {
    const rdapAvailable = rdap.status === DomainStatus.Available && !rdap.isPremium;
    const whoisAvailable = whois.available;

    if (rdapAvailable === whoisAvailable) {
      const rdapResult = rdapToResult(rdap);
      const whoisResult = whoisToResult(whois);
      const merged: AvailabilityResult = { ...rdapResult, source: 'cross-validated' };
      if (whoisResult.registrar !== undefined) merged.registrar = whoisResult.registrar;
      if (whoisResult.expiresAt !== undefined) merged.expiresAt = whoisResult.expiresAt;
      if (whoisResult.createdDate !== undefined) merged.createdDate = whoisResult.createdDate;
      if (whoisResult.domainAge !== undefined) merged.domainAge = whoisResult.domainAge;
      return merged;
    }

    getLogger().warn(
      {
        domain,
        rdapStatus: rdap.status,
        rdapIsPremium: rdap.isPremium,
        whoisAvailable,
      },
      `RDAP/WHOIS cross-validation disagreement for ${domain} — ` +
        `RDAP says ${rdapAvailable ? 'available' : 'registered'}, ` +
        `WHOIS says ${whoisAvailable ? 'available' : 'registered'}. ` +
        `Conservatively filtering as registered.`,
    );

    return {
      domain,
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
      source: 'cross-validated',
    };
  }
}
