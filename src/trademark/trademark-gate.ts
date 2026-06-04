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
  matchedMark?: string;
  matchedOwner?: string;
  matchSource?: string;
}

export class TrademarkGate {
  constructor(
    private readonly usptoProvider: TrademarkProvider,
    private readonly euipoProvider: TrademarkProvider,
  ) {}

  async check(domain: string): Promise<GateResult> {
    const sld = extractSld(domain);
    let usptoMatches = [] as Awaited<ReturnType<TrademarkProvider['search']>>;
    let euipoMatches = [] as Awaited<ReturnType<TrademarkProvider['search']>>;
    let hadError = false;

    try {
      usptoMatches = await this.usptoProvider.search(sld);
    } catch {
      hadError = true;
    }

    try {
      euipoMatches = await this.euipoProvider.search(sld);
    } catch {
      hadError = true;
    }

    const allMatches = [...usptoMatches, ...euipoMatches];
    const detected = detectMatch(sld, allMatches);

    if (detected !== null) {
      return {
        domain,
        verdict: GateVerdict.Blocked,
        matchedMark: detected.markName,
        matchedOwner: detected.owner,
        matchSource: detected.source,
      };
    }

    return {
      domain,
      verdict: hadError ? GateVerdict.Unverified : GateVerdict.Clear,
    };
  }
}
