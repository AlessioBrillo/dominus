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

/** Per-check observability snapshot handed to the optional telemetry
 *  callback (wired to the metrics collector in the composition root). */
export interface TrademarkGateStats {
  domain: string;
  verdict: GateVerdict;
  /** True when the verdict relied on a single responding source. */
  partial?: boolean | undefined;
  usptoOk: boolean;
  euipoOk: boolean;
  durationMs: number;
}

export interface TrademarkGateOptions {
  /**
   * Bounded per-provider deadline for each trademark lookup. When the
   * deadline fires the provider call counts as a failure (conservative,
   * ADR-0012: a strict-TLD domain becomes Unverified instead of being
   * cleared on one source alone). Default: no gate-level deadline — the
   * provider stack's own retry/timeout policies apply.
   */
  providerTimeoutMs?: number;
  /** Optional telemetry sink invoked once per check() with the outcome. */
  onResult?: (stats: TrademarkGateStats) => void;
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
  private providerTimeoutMs: number | undefined;
  private onResult: (stats: TrademarkGateStats) => void;

  constructor(
    usptoProvider: TrademarkProvider,
    euipoProvider: TrademarkProvider,
    matchConfig: MatchDetectorConfig = DEFAULT_MATCH_DETECTOR_CONFIG,
    options: TrademarkGateOptions = {},
  ) {
    this.usptoProvider = usptoProvider;
    this.euipoProvider = euipoProvider;
    this.matchConfig = matchConfig;
    this.providerTimeoutMs = options.providerTimeoutMs;
    this.onResult = options.onResult ?? ((): void => {});
  }

  async check(domain: string, signal?: AbortSignal): Promise<GateResult> {
    const sld = getSldForTrademark(domain) || extractSld(domain);
    const startedAt = performance.now();

    // Parallel trademark gate: both sources race and verdicts are combined.
    // Each provider (RetryingTrademarkProvider + CircuitBreaker) already
    // handles its own timeout/retry/breaker — the gate only orchestrates
    // and picks the conservative verdict per ADR-0012.
    //
    // An optional gate-level deadline (TRADEMARK_PROVIDER_TIMEOUT_MS) is
    // combined with the caller's signal, so run cancellation still
    // propagates instantly while a hung provider is bounded. Providers
    // observe any abort as AbortError; the reject handler below maps that
    // to a provider failure UNLESS the caller's own signal aborted, in
    // which case the cancellation propagates (an aborted run must not
    // manufacture a verdict).
    const timeoutSignal =
      this.providerTimeoutMs !== undefined
        ? AbortSignal.timeout(this.providerTimeoutMs)
        : undefined;
    const combinedSignal =
      timeoutSignal !== undefined
        ? signal !== undefined
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal
        : signal;

    const [usptoResult, euipoResult] = await Promise.all([
      this.searchSource(this.usptoProvider, sld, signal, combinedSignal),
      this.searchSource(this.euipoProvider, sld, signal, combinedSignal),
    ]);

    const allMatches = [...usptoResult.matches, ...euipoResult.matches];
    const detected = detectMatch(sld, allMatches, this.matchConfig);

    let result: GateResult;
    if (detected !== null) {
      result = {
        domain,
        verdict: GateVerdict.Blocked,
        verifiedSources: [],
        matchedMark: detected.markName,
        matchedOwner: detected.owner,
        matchSource: detected.source,
      };
    } else {
      const verifiedSources: string[] = [];
      if (usptoResult.ok) {
        verifiedSources.push('USPTO');
      }
      if (euipoResult.ok) {
        verifiedSources.push('EUIPO');
      }

      if (!usptoResult.ok && isStrictTld(domain)) {
        logger.warn(
          {
            domain,
            verifiedSources,
          },
          'Trademark gate: USPTO unreachable for strict-TLD domain — verdict: Unverified',
        );
        result = {
          domain,
          verdict: GateVerdict.Unverified,
          verifiedSources,
          usptoFailed: true,
        };
      } else if (verifiedSources.length === 0) {
        logger.error(
          { domain },
          'Trademark gate: all trademark sources failed — verdict: Unverified',
        );
        result = { domain, verdict: GateVerdict.Unverified, verifiedSources };
      } else {
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
        result = { domain, verdict: GateVerdict.Clear, verifiedSources, partial };
      }
    }

    this.#emitStats({
      domain,
      verdict: result.verdict,
      partial: result.partial,
      usptoOk: usptoResult.ok,
      euipoOk: euipoResult.ok,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return result;
  }

  private async searchSource(
    provider: TrademarkProvider,
    sld: string,
    runSignal: AbortSignal | undefined,
    combinedSignal: AbortSignal | undefined,
  ): Promise<{ ok: true; matches: TrademarkMatch[] } | { ok: false; matches: never[] }> {
    try {
      const matches = await provider.search(sld, combinedSignal);
      return { ok: true as const, matches };
    } catch (err) {
      if (runSignal !== undefined && runSignal.aborted) throw err;
      return { ok: false as const, matches: [] };
    }
  }

  #emitStats(stats: TrademarkGateStats): void {
    try {
      this.onResult(stats);
    } catch (err) {
      // A broken telemetry sink must never break the gate itself.
      logger.error({ err, domain: stats.domain }, 'Trademark gate: telemetry callback failed');
    }
  }
}
