import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate, WhoisMeta } from '../../types/candidate.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { WhoisProvider, WhoisResult } from '../../providers/whois/whois-provider.js';
import type { Stage, StageResult } from '../stage.js';
import { getLogger } from '../../logger.js';

const DEFAULT_ENRICH_TIMEOUT_MS = 10_000;

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

export class RdapConfirmationStage implements Stage<DomainCandidate> {
  readonly name = 'RdapConfirmationStage';

  constructor(
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider?: WhoisProvider,
    private readonly concurrency: number = 5,
    private readonly enrichTimeoutMs: number = DEFAULT_ENRICH_TIMEOUT_MS,
  ) {}

  async process(
    candidates: DomainCandidate[],
    signal?: AbortSignal,
  ): Promise<StageResult<DomainCandidate>> {
    const start = Date.now();
    if (signal?.aborted) return { passed: [], filtered: [], stageName: this.name, durationMs: 0 };

    const passed: DomainCandidate[] = [];
    const filtered: DomainCandidate[] = [];

    const batches = this.#toBatches(candidates, this.concurrency);
    for (const batch of batches) {
      if (signal?.aborted) break;
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          try {
            const result = await this.#checkAvailability(candidate.domain, signal);
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

    return { passed, filtered, stageName: this.name, durationMs: Date.now() - start };
  }

  #toBatches<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }
    return batches;
  }

  async #checkAvailability(domain: string, signal?: AbortSignal): Promise<AvailabilityResult> {
    const timeoutSignal = AbortSignal.timeout(this.enrichTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    if (this.whoisProvider === undefined) {
      const rdap = await this.rdapProvider.confirm(domain, combined);
      return rdapToResult(rdap);
    }

    const [rdapSettled, whoisSettled] = await Promise.allSettled([
      this.rdapProvider.confirm(domain, combined),
      this.whoisProvider.checkAvailability(domain, combined),
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
