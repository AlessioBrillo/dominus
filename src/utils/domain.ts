/**
 * Domain-name utilities.
 *
 * Three responsibilities, layered:
 *  1. `normalizeDomain` — full validation pipeline: BOM strip, IDN→ASCII,
 *     PSL parse, label syntax check, punycode→unicode.
 *  2. `isValidDomain`  — RFC-1123-ish syntactic check delegating to
 *     `normalizeDomain`.
 *  3. `parseDomain`    — split a domain into its second-level label (SLD)
 *     and top-level label (TLD) using the full Public Suffix List via the
 *     `psl` npm package.
 *
 * Lower-case normalisation is the parser's responsibility — callers can
 * pass mixed case and trust the output to be lowercase.
 *
 * ADR-0013 and ADR-0015 record the rationale for this module.
 *
 * This module is the SINGLE source of truth for domain validation.
 * `src/utils/domain-validator.ts` is a deprecated re-export shim.
 */

import psl from 'psl';
import { domainToASCII, domainToUnicode } from 'node:url';

export interface NormalizedDomain {
  raw: string;
  normalized: string;
  sld: string;
  tld: string;
  sldUnicode: string;
  isValid: boolean;
  invalidReason?: string | undefined;
}

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]+|[a-z]{2,})$/;

const PUNY_RE = /^xn--/i;

const BOM_RE = /^\uFEFF/;

function hasNonAscii(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) return true;
  }
  return false;
}

function validateLabelSyntax(label: string): string | null {
  if (label.length === 0) return 'empty label';
  if (label.length > 63) return 'label exceeds 63 characters';
  if (label.startsWith('-')) return 'label starts with hyphen';
  if (label.endsWith('-')) return 'label ends with hyphen';
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (!(c === 45 || (c >= 48 && c <= 57) || (c >= 97 && c <= 122))) {
      return `invalid character in label: ${label[i]}`;
    }
  }
  return null;
}

/** Full validation pipeline: BOM strip, IDN→ASCII, PSL parse, label syntax. */
export function normalizeDomain(input: string): NormalizedDomain {
  const raw = input.replace(BOM_RE, '').trim();
  if (raw === '') {
    return {
      raw,
      normalized: '',
      sld: '',
      tld: '',
      sldUnicode: '',
      isValid: false,
      invalidReason: 'empty domain',
    };
  }

  let ascii: string;
  let hasIdn = false;
  try {
    if (hasNonAscii(raw)) {
      ascii = domainToASCII(raw);
      hasIdn = true;
    } else {
      ascii = raw.toLowerCase();
    }
  } catch {
    return {
      raw,
      normalized: '',
      sld: '',
      tld: '',
      sldUnicode: '',
      isValid: false,
      invalidReason: 'IDN conversion failed',
    };
  }

  const lower = ascii.toLowerCase();

  if (!hasIdn && lower.includes('.')) {
    for (const label of lower.split('.')) {
      if (PUNY_RE.test(label)) {
        hasIdn = true;
        break;
      }
    }
  }

  if (!DOMAIN_RE.test(lower)) {
    let reason = 'syntax validation failed';
    const labels = lower.split('.');
    for (const label of labels) {
      const labelErr = validateLabelSyntax(label);
      if (labelErr) {
        reason = labelErr;
        break;
      }
    }
    return {
      raw,
      normalized: lower,
      sld: '',
      tld: '',
      sldUnicode: '',
      isValid: false,
      invalidReason: reason,
    };
  }

  let sld: string;
  let tld: string;
  try {
    const parsed = psl.parse(lower);
    if (parsed.error || !parsed.sld || !parsed.tld) {
      return {
        raw,
        normalized: lower,
        sld: '',
        tld: '',
        sldUnicode: '',
        isValid: false,
        invalidReason: 'unrecognisable domain',
      };
    }
    sld = parsed.sld;
    tld = `.${parsed.tld}`;
  } catch {
    return {
      raw,
      normalized: lower,
      sld: '',
      tld: '',
      sldUnicode: '',
      isValid: false,
      invalidReason: 'PSL parse failed',
    };
  }

  let sldUnicode: string;
  if (hasIdn && PUNY_RE.test(sld)) {
    try {
      sldUnicode = domainToUnicode(sld);
    } catch {
      sldUnicode = sld;
    }
  } else {
    sldUnicode = sld;
  }

  return { raw, normalized: lower, sld, tld, sldUnicode, isValid: true };
}

/** Syntactic validity delegating to `normalizeDomain`. */
export function isValidDomain(value: string): boolean {
  return normalizeDomain(value).isValid;
}

/** Extract the SLD with Unicode decoding (for trademark matching). */
export function getSldForTrademark(domain: string): string {
  const norm = normalizeDomain(domain);
  if (!norm.isValid) return '';
  return norm.sldUnicode || norm.sld;
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

/**
 * Normalise a TLD for registrar pricing map lookups.
 *
 * Registrar pricing maps use underscores for multi-label TLDs
 * (e.g. `co_uk`, `org_uk`, `com_au`) because dots are used as
 * key separators in flat maps. This function:
 *  1. Parses the domain via the full Public Suffix List (psl)
 *  2. Strips the leading dot
 *  3. Replaces remaining dots with underscores
 *
 * Examples:
 *  `example.co.uk`  →  `co_uk`
 *  `example.com.au` →  `com_au`
 *  `example.com`    →  `com`
 *  `example.io`     →  `io`
 */
export function extractRegistrarTld(domain: string): string {
  const tld = extractTld(domain);
  if (tld === '' || tld === '.') return '';
  // Strip leading dot, then replace remaining dots with underscores
  return tld.slice(1).replace(/\./g, '_');
}

export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
