import { domainToASCII, domainToUnicode } from 'node:url';
import psl from 'psl';
import { extractSld, extractTld } from './domain.js';

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

  // Also detect punycode that arrived as raw ASCII (e.g. "xn--mgba3a4f16a.com")
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

export function isValidDomain(input: string): boolean {
  return normalizeDomain(input).isValid;
}

export function getSldForTrademark(domain: string): string {
  const norm = normalizeDomain(domain);
  if (!norm.isValid) return '';
  return norm.sldUnicode || norm.sld;
}

export { extractSld, extractTld };
