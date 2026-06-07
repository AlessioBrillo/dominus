/**
 * Domain-name utilities.
 *
 * Two responsibilities, layered:
 *  1. `isValidDomain` — RFC-1123-ish syntactic check (ASCII, label rules).
 *  2. `parseDomain`  — split a domain into its second-level label (SLD)
 *     and top-level label (TLD) using the full Public Suffix List via the
 *     `psl` npm package. This replaces the hand-curated `MULTI_PART_TLDS`
 *     set (see ADR-0015).
 *
 * Lower-case normalisation is the parser's responsibility — callers can
 * pass mixed case and trust the output to be lowercase.
 *
 * ADR-0013 and ADR-0015 record the rationale for this module.
 */

import psl from 'psl';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

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
 * Parse a domain into its SLD and TLD using the full Public Suffix List
 * via the `psl` npm package. Returns the correct result for multi-part
 * ccTLDs (`nike.co.uk` → `{ sld: 'nike', tld: '.co.uk' }`) and
 * ordinary subdomain prefixes (`sub.domain.com` → `{ sld: 'domain',
 * tld: '.com' }`).
 *
 * The output is empty-string-tolerant: `parseDomain('').sld === ''`
 * and `.tld` defaults to `.com` for malformed input, matching the
 * prior `extractTld` contract used by the candidate generation stage.
 */
export function parseDomain(raw: string): ParsedDomain {
  const input = raw.toLowerCase().trim();
  if (input === '') {
    return { input: '', sld: '', tld: '.com' };
  }
  const parsed = psl.parse(input);
  if (parsed.error || !parsed.sld || !parsed.tld) {
    // Single label or unrecognisable — preserve as SLD, default TLD.
    return { input, sld: input, tld: '.com' };
  }
  return {
    input,
    sld: parsed.sld,
    tld: `.${parsed.tld}`,
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
