import type { TrademarkProvider } from '../providers/trademark/trademark-provider.js';
import { detectMatch, extractSld } from './match-detector.js';

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
  const lower = domain.toLowerCase();
  for (const tld of STRICT_USPTO_TLDS) {
    if (lower.endsWith(tld)) return true;
  }
  return false;
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
  constructor(
    private readonly usptoProvider: TrademarkProvider,
    private readonly euipoProvider: TrademarkProvider,
  ) {}

  async check(domain: string): Promise<GateResult> {
    const sld = extractSld(domain);

    const [usptoResult, euipoResult] = await Promise.all([
      this.usptoProvider.search(sld).then(
        (matches) => ({ ok: true as const, matches }),
        () => ({ ok: false as const, matches: [] }),
      ),
      this.euipoProvider.search(sld).then(
        (matches) => ({ ok: true as const, matches }),
        () => ({ ok: false as const, matches: [] }),
      ),
    ]);

    const verifiedSources: string[] = [];
    if (usptoResult.ok) verifiedSources.push('USPTO');
    if (euipoResult.ok) verifiedSources.push('EUIPO');

    const allMatches = [...usptoResult.matches, ...euipoResult.matches];
    const detected = detectMatch(sld, allMatches);

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

    // Strict-TLD rule: a US-jurisdiction TLD must have a USPTO answer
    // before we issue any verdict. If USPTO is down, we degrade to
    // Unverified even if EUIPO was clean.
    if (!usptoResult.ok && isStrictTld(domain)) {
      return {
        domain,
        verdict: GateVerdict.Unverified,
        verifiedSources,
        usptoFailed: true,
      };
    }

    if (verifiedSources.length === 0) {
      // All sources failed — cannot confirm clearance (Principle 6)
      return { domain, verdict: GateVerdict.Unverified, verifiedSources };
    }

    const partial = verifiedSources.length < 2;
    return { domain, verdict: GateVerdict.Clear, verifiedSources, partial };
  }
}
