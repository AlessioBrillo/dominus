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
  secondaryProvider: RdapProvider;
  secondaryOrigin: string;
  degradedRatio?: number;
  degradedMin?: number;
  consensusConcurrency?: number;
  rescueWhoisEnabled?: boolean;
  rescueWhoisTlds?: Set<string>;
  tldOriginsResolver?: (tld: string) => Promise<string[]>;
}

const DEFAULT_CONSENSUS_DEGRADED_RATIO = 0.5;
const DEFAULT_CONSENSUS_DEGRADED_MIN = 10;
const DEFAULT_CONSENSUS_CONCURRENCY = 10;

export class RdapConfirmationStage implements Stage<DomainCandidate> {
  readonly name = 'RdapConfirmationStage';

  constructor(
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider?: WhoisProvider,
    private readonly concurrency: number = 10,
    private readonly enrichTimeoutMs: number = DEFAULT_ENRICH_TIMEOUT_MS,
    private readonly whoisBudgetMs: number = DEFAULT_WHOIS_BUDGET_MS,
    private readonly freshRdapProvider?: RdapProvider,
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

    const survivor = new Set<string>();

    const secondaryOrigin = rdapUrlOrigin(cfg.secondaryOrigin);
    const authoritativeOriginsByTld = new Map<string, string[]>();
    const authoritativeOriginsInFlight = new Map<string, Promise<string[] | undefined>>();
    const resolveAuthoritativeOrigins = async (tld: string): Promise<string[] | undefined> => {
      if (cfg.tldOriginsResolver === undefined) return undefined;
      const cached = authoritativeOriginsByTld.get(tld);
      if (cached !== undefined) return cached;
      const inFlight = authoritativeOriginsInFlight.get(tld);
      if (inFlight !== undefined) return inFlight;
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
            logger.warn(
              { error, tld: candidate.tld, domain: candidate.domain },
              'RDAP: authoritative origin lookup failed — verification leg not consulted (fail-closed, ADR-0060)',
            );
            return {
              candidate,
              secondaryResult: undefined,
              secondaryOverlap: false,
              secondaryGuardUnavailable: true,
            };
          }

          let secondaryResult: RdapResult | undefined;
          let secondaryOverlap = false;
          let secondaryGuardUnavailable = false;
          let secondaryWinnerOverlap = false;

          try {
            const authoritativeOverlap =
              authoritativeOrigins !== undefined &&
              hasAuthoritativeOriginOverlap(authoritativeOrigins, cfg.secondaryOrigin);
            const winnerOverlap = hasWinningOriginOverlap(
              winningOrigins.get(candidate.domain),
              cfg.secondaryOrigin,
            );
            if (authoritativeOverlap || winnerOverlap) {
              secondaryOverlap = true;
              secondaryWinnerOverlap = winnerOverlap;
            } else {
              secondaryResult = await cfg.secondaryProvider.confirm(candidate.domain, signal);
            }
          } catch {
            // Ignore secondary provider errors — treated as unverifiable
          }

          return {
            candidate,
            secondaryResult,
            secondaryOverlap,
            secondaryGuardUnavailable,
            secondaryWinnerOverlap,
            secondaryConfirmed:
              secondaryResult !== undefined &&
              secondaryResult.status === DomainStatus.Available &&
              !secondaryResult.isPremium,
          };
        }),
      );

      for (const {
        candidate,
        secondaryResult,
        secondaryOverlap,
        secondaryGuardUnavailable,
        secondaryWinnerOverlap,
        secondaryConfirmed,
      } of results) {
        if (secondaryGuardUnavailable) {
          stats.unverifiable++;
          stats.originGuardUnavailable = (stats.originGuardUnavailable ?? 0) + 1;
        } else if (secondaryOverlap) {
          stats.unverifiable++;
          stats.originOverlap = (stats.originOverlap ?? 0) + 1;
          logger.warn(
            { domain: candidate.domain, origin: secondaryOrigin },
            secondaryWinnerOverlap === true
              ? 'RDAP: 2-of-2 consensus skipped — the primary verdict was served by the ' +
                  'second leg origin (same server, rubber-stamp guard, ADR-0050) — ' +
                  'downgraded as unverifiable'
              : 'RDAP: 2-of-2 consensus skipped — the second leg origin is authoritative ' +
                  'for the candidate TLD (rubber-stamp guard, ADR-0058) — downgraded as ' +
                  'unverifiable',
          );
        } else if (secondaryResult !== undefined) {
          if (secondaryResult.status === DomainStatus.Available && !secondaryResult.isPremium) {
            survivor.add(candidate.domain);
            stats.verified++;
            continue;
          }
          if (secondaryResult.status === DomainStatus.Registered || secondaryResult.isPremium) {
            stats.disagreed++;
            logger.warn(
              {
                domain: candidate.domain,
                secondStatus: secondaryResult.status,
                isPremium: secondaryResult.isPremium,
              },
              'RDAP: 2-of-2 consensus vetoed (second leg says registered) — downgraded',
            );
            continue;
          }
        }

        const forceRescue = cfg.rescueWhoisTlds?.has(candidate.tld.toLowerCase()) === true;
        if (
          (cfg.rescueWhoisEnabled === true || forceRescue) &&
          this.whoisProvider !== undefined &&
          !secondaryConfirmed
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
      }
    }

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
      filtered.push({
        ...candidate,
        rdapStatus: DomainStatus.Unknown,
        isPremium: false,
        status: CandidateStatus.RdapFiltered,
      });
    }
    return remaining;
  }

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

    let whois: WhoisResult | undefined;
    try {
      const whoisBudgetSignal = AbortSignal.any([
        combined,
        AbortSignal.timeout(this.whoisBudgetMs),
      ]);
      whois = await Promise.race([
        this.whoisProvider
          .checkAvailability(domain, whoisBudgetSignal, {
            forceRecheck: candidate.forceWhoisRecheck === true,
          })
          .catch(() => undefined),
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
