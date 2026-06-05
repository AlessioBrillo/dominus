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
  matchedMark?: string | undefined;
  matchedOwner?: string | undefined;
  matchSource?: string | undefined;
}

/**
 * Degrade-gracefully logic:
 * - Any source returns a match → Blocked (regardless of other source errors).
 * - ≥1 source responds without error AND no match found → Clear.
 *   `partial` is true when one source errored.
 * - All sources errored → Unverified (no recommendation produced, Principle 6).
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

    if (verifiedSources.length === 0) {
      // All sources failed — cannot confirm clearance (Principle 6)
      return { domain, verdict: GateVerdict.Unverified, verifiedSources };
    }

    const partial = verifiedSources.length < 2;
    return { domain, verdict: GateVerdict.Clear, verifiedSources, partial };
  }
}
