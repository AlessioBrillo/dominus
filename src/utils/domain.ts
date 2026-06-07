/**
 * Domain-name utilities.
 *
 * Two responsibilities, layered:
 *  1. `isValidDomain` — RFC-1123-ish syntactic check (ASCII, label rules).
 *  2. `parseDomain`  — split a domain into its second-level label (SLD)
 *     and top-level label (TLD), handling multi-part ccTLDs (e.g. `co.uk`,
 *     `com.au`). The `MULTI_PART_TLDS` set is the single source of truth
 *     for the curated list and is shared with the trademark match detector
 *     (see `src/trademark/match-detector.ts`).
 *
 * Lower-case normalisation is the parser's responsibility — callers can
 * pass mixed case and trust the output to be lowercase.
 *
 * ADR-0013 records why this lives here rather than inside the scoring or
 * trademark modules: the bug it fixes (ccTLDs scored with the wrong SLD)
 * is silent and was easy to overlook because the affected names are a
 * small minority of the candidate set.
 */

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Curated subset of the Public Suffix List covering the country and
 * second-level suffixes DOMINUS is most likely to encounter. A future
 * ADR may swap this for a full PSL parser; the matching/trademark logic
 * imports the constant by name, so the call sites do not change.
 */
export const MULTI_PART_TLDS: ReadonlySet<string> = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tw', 'com.tr',
  'ne.jp', 'or.jp', 'ac.uk', 'gov.uk', 'org.uk', 'net.uk', 'sch.uk',
  'co.il', 'co.ke', 'co.id', 'com.ar', 'com.co', 'com.pe', 'com.ve',
]);

/** Syntactic validity (RFC-1123-ish, ASCII-only). */
export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(value.toLowerCase());
}

/**
 * Result of `parseDomain`. Both fields are lowercase. `sld` is the
 * second-level label (the part the operator cares about); `tld` includes
 * the leading dot and is a multi-part string when applicable
 * (`.co.uk` not `.uk`).
 */
export interface ParsedDomain {
  /** Original input, trimmed and lowercased. */
  input: string;
  /** Second-level label, e.g. `nike` for `nike.co.uk`. */
  sld: string;
  /** Top-level label including the leading dot, e.g. `.co.uk`. */
  tld: string;
}

/**
 * Parse a domain into its SLD and TLD. Multi-part TLDs are recognised
 * via the `MULTI_PART_TLDS` set, so `nike.co.uk` returns
 * `{ sld: 'nike', tld: '.co.uk' }` (not `{ sld: 'nikeco', tld: '.uk' }`
 * as the naive split would). The output is empty-string-tolerant:
 * `parseDomain('').sld === ''` and `.tld` defaults to `.com` for
 * malformed input, matching the prior `extractTld` contract used by
 * the candidate generation stage.
 */
export function parseDomain(raw: string): ParsedDomain {
  const input = raw.toLowerCase().trim();
  if (input === '') {
    return { input: '', sld: '', tld: '.com' };
  }
  const parts = input.split('.');
  if (parts.length < 2) {
    // No TLD detectable — preserve the input as the SLD and default the TLD.
    return { input, sld: input, tld: '.com' };
  }
  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2] ?? ''}.${parts[parts.length - 1] ?? ''}`;
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return {
        input,
        sld: parts.slice(0, -2).join('.'),
        tld: `.${lastTwo}`,
      };
    }
  }
  return {
    input,
    sld: parts[0] ?? '',
    tld: `.${parts[parts.length - 1] ?? 'com'}`,
  };
}

/**
 * Return the top-level label including the leading dot.
 * Convenience wrapper around `parseDomain(...).tld`.
 */
export function extractTld(raw: string): string {
  return parseDomain(raw).tld;
}

/**
 * Return the second-level label.
 * Convenience wrapper around `parseDomain(...).sld`.
 */
export function extractSld(raw: string): string {
  return parseDomain(raw).sld;
}
