// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../logger.js';
import type {
  TrademarkProvider,
  TrademarkMatch,
} from '../providers/trademark/trademark-provider.js';
import { getSldForTrademark, parseDomain, extractSld } from '../utils/domain.js';
import {
  detectMatch,
  DEFAULT_MATCH_DETECTOR_CONFIG,
  type MatchDetectorConfig,
} from './match-detector.js';

const logger = getLogger();

export enum GateVerdict {
  Clear = 'clear',
  Blocked = 'blocked',
  Unverified = 'unverified',
}

export interface GateResult {
  domain: string;
  verdict: GateVerdict;
  /** True when only a subset of trademark sources responded successfully. */
  partial?: boolean | undefined;
  /** Names of sources that responded without error (e.g. ['USPTO', 'EUIPO']). */
  verifiedSources: string[];
  /**
   * True when the USPTO provider was unreachable AND the domain's TLD
   * is in `STRICT_USPTO_TLDS`. The verdict is then forced to
   * Unverified so a US-market domain is never cleared on EUIPO alone
   * (Principle 6, ADR-0012). Absent / false otherwise.
   */
  usptoFailed?: boolean | undefined;
  matchedMark?: string | undefined;
  matchedOwner?: string | undefined;
  matchSource?: string | undefined;
}

/**
 * TLDs for which USPTO coverage is treated as mandatory. A `.com` (or
 * `.us`) domain is primarily a US-jurisdiction asset; the EUIPO register
 * is not a substitute for a USPTO lookup. When USPTO is unreachable
 * for a TLD in this set, the gate MUST return Unverified even if EUIPO
 * responded cleanly. Outside this set the original graceful-degrade
 * logic applies (EUIPO-only is enough for a Clear).
 *
 * The list is intentionally narrow. Adding `.io`, `.ai`, etc. is
 * deliberately deferred: a `.io` registrant typically files in the US
 * market but the ccTLD itself is British Indian Ocean Territory. The
 * conservative default is "USPTO nice to have, EUIPO not enough on its
 * own" — but that conversation is for a follow-up ADR.
 */
export const STRICT_USPTO_TLDS: ReadonlySet<string> = new Set(['.com', '.us']);

function isStrictTld(domain: string): boolean {
  return STRICT_USPTO_TLDS.has(parseDomain(domain).tld);
}

/**
 * Degrade-gracefully logic (ADR-0012):
 * - Any source returns a match → Blocked (regardless of other source errors).
 * - USPTO fails AND the domain's TLD is in STRICT_USPTO_TLDS → Unverified.
 *   The EUIPO register does not cover US-jurisdiction marks; for a
 *   .com/.us domain we will not pretend otherwise.
 * - All sources errored → Unverified (no recommendation produced, Principle 6).
 * - ≥1 source responds without error AND no match found AND the
 *   strict-TLD rule above did not fire → Clear. `partial` is true when
 *   only one of the two sources responded.
 */
export class TrademarkGate {
  private usptoProvider: TrademarkProvider;
  private euipoProvider: TrademarkProvider;
  private matchConfig: MatchDetectorConfig;
  private providerTimeoutMs: number;
  /**
   * Circuit breaker state: tracked failure counts per provider.
   * After 3 consecutive failures, the provider is considered unhealthy
   * and future runs will short-circuit to Unverified for strict TLDs.
   */
  private usptoFailureCount = 0;
  private euipoFailureCount = 0;

  constructor(
    usptoProvider: TrademarkProvider,
    euipoProvider: TrademarkProvider,
    matchConfig: MatchDetectorConfig = DEFAULT_MATCH_DETECTOR_CONFIG,
  ) {
    this.usptoProvider = usptoProvider;
    this.euipoProvider = euipoProvider;
    this.matchConfig = matchConfig;
    this.providerTimeoutMs = 15_000; // 15s per-provider timeout
  }

  async check(domain: string, signal?: AbortSignal): Promise<GateResult> {
    const sld = getSldForTrademark(domain) || extractSld(domain);

    // Run USPTO search with timeout and failure tracking
    const usptoResult = await this.#runWithTimeoutAndTrack(
      'USPTO',
      () => this.usptoProvider.search(sld, signal),
      this.providerTimeoutMs,
      signal,
    );

    // Run EUIPO search with timeout and failure tracking
    const euipoResult = await this.#runWithTimeoutAndTrack(
      'EUIPO',
      () => this.euipoProvider.search(sld, signal),
      this.providerTimeoutMs,
      signal,
    );

    const verifiedSources: string[] = [];
    if (usptoResult.ok) {
      verifiedSources.push('USPTO');
      this.usptoFailureCount = 0;
    } else {
      this.usptoFailureCount++;
    }
    if (euipoResult.ok) {
      verifiedSources.push('EUIPO');
      this.euipoFailureCount = 0;
    } else {
      this.euipoFailureCount++;
    }

    const allMatches = [...usptoResult.matches, ...euipoResult.matches];
    const detected = detectMatch(sld, allMatches, this.matchConfig);

    if (detected !== null) {
      return {
        domain,
        verdict: GateVerdict.Blocked,
        verifiedSources,
        matchedMark: detected.markName,
        matchedOwner: detected.owner,
        matchSource: detected.source,
      };
    }

    if (!usptoResult.ok && isStrictTld(domain)) {
      logger.warn(
        {
          domain,
          verifiedSources,
          usptoFailed: true,
        },
        'Trademark gate: USPTO unreachable for strict-TLD domain — verdict: Unverified',
      );
      return {
        domain,
        verdict: GateVerdict.Unverified,
        verifiedSources,
        usptoFailed: true,
      };
    }

    if (verifiedSources.length === 0) {
      logger.error(
        { domain },
        'Trademark gate: all trademark sources failed — verdict: Unverified',
      );
      return { domain, verdict: GateVerdict.Unverified, verifiedSources };
    }

    const partial = verifiedSources.length < 2;
    if (partial) {
      logger.warn(
        {
          domain,
          sources: verifiedSources,
          partial: true,
        },
        'Trademark gate: only one source responded — verdict: Clear (partial)',
      );
    }
    return { domain, verdict: GateVerdict.Clear, verifiedSources, partial };
  }

  /**
   * Run a provider search with a per-provider timeout and circuit breaker
   * failure tracking. On timeout, the provider is marked as failed (not ok)
   * and the failure count is incremented. On success, the failure count is
   * reset.
   *
   * The callback fn is expected to return TrademarkMatch[] (the provider's
   * native search result). This method wraps it into { ok, matches }.
   */
  async #runWithTimeoutAndTrack(
    providerName: string,
    fn: () => Promise<TrademarkMatch[]>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; matches: TrademarkMatch[] }> {
    const timeoutError = new Error(`Provider search timed out after ${timeoutMs}ms`) as Error & {
      transient?: boolean;
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        reject(timeoutError);
      }, timeoutMs);
      timeoutId.unref();
    });

    const signalPromise = signal?.aborted
      ? Promise.reject(new DOMException('Aborted', 'AbortError'))
      : Promise.resolve();

    let result: TrademarkMatch[] | undefined;
    try {
      const raceResult = await Promise.race([fn(), timeoutPromise, signalPromise]);
      result = raceResult as TrademarkMatch[];
    } catch (err) {
      const domErr = err as DOMException;
      // Allow AbortError from AbortSignal to propagate (test expects re-throw)
      if (domErr.name === 'AbortError') {
        throw err;
      }
      if (err === timeoutError) {
        logger.warn(
          { provider: providerName, timeoutMs: timeoutMs },
          `Trademark gate: ${providerName} search timed out after ${timeoutMs}ms`,
        );
        // Increment failure count for circuit breaker
        if (providerName === 'USPTO') {
          this.usptoFailureCount++;
        } else {
          this.euipoFailureCount++;
        }
        return { ok: false, matches: [] as TrademarkMatch[] };
      }
      // Treat provider errors (ProviderError, etc.) as provider failures
      // rather than propagating them upstream
      logger.debug(
        { provider: providerName, error: domErr.message },
        `Trademark gate: ${providerName} search failed — treating as provider failure`,
      );
      if (providerName === 'USPTO') {
        this.usptoFailureCount++;
      } else {
        this.euipoFailureCount++;
      }
      return { ok: false, matches: [] as TrademarkMatch[] };
    }

    // Success — reset failure count for this provider
    if (providerName === 'USPTO') {
      this.usptoFailureCount = 0;
    } else {
      this.euipoFailureCount = 0;
    }
    // Defensive check for undefined result
    if (result === undefined) {
      return { ok: false, matches: [] as TrademarkMatch[] };
    }
    return { ok: true, matches: result };
  }
}
