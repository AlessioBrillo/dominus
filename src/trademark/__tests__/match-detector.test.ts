import { describe, it, expect } from 'vitest';
import { detectMatch, extractSld } from '../match-detector.js';
import type { MatchCandidate } from '../match-detector.js';

const NIKE: MatchCandidate = { markName: 'Nike', owner: 'Nike Inc.', status: 'registered', source: 'uspto' };
const APPLE: MatchCandidate = { markName: 'Apple', owner: 'Apple Inc.', status: 'registered', source: 'uspto' };
const APP_STORE: MatchCandidate = { markName: 'App Store', owner: 'Apple Inc.', status: 'registered', source: 'uspto' };
const CHAN: MatchCandidate = { markName: 'Chan', owner: '4chan LLC', status: 'registered', source: 'uspto' };
const STATE_FARM: MatchCandidate = { markName: 'State Farm', owner: 'State Farm', status: 'registered', source: 'uspto' };
const BOSS: MatchCandidate = { markName: 'Boss', owner: 'Hugo Boss', status: 'registered', source: 'uspto' };

describe('detectMatch', () => {
  it('exact match is detected (case-insensitive)', () => {
    const result = detectMatch('nike', [NIKE]);
    expect(result).not.toBeNull();
    expect(result?.markName).toBe('Nike');
  });

  it('substring containment of the mark in the SLD still flags a match (mark <= sld)', () => {
    const result = detectMatch('nikestore', [NIKE]);
    expect(result).not.toBeNull();
  });

  it('no match returns null', () => {
    const result = detectMatch('nova', [NIKE, APPLE]);
    expect(result).toBeNull();
  });

  it('returns null for empty marks list', () => {
    const result = detectMatch('anything', []);
    expect(result).toBeNull();
  });

  it('does NOT match a short SLD token against a longer mark (regression: app vs Apple)', () => {
    // The old substring rule matched this; token policy correctly declines.
    const result = detectMatch('app', [APPLE]);
    expect(result).toBeNull();
  });

  it('does NOT match a 2-letter SLD token against a 4-letter mark (regression: bo vs Boss)', () => {
    const result = detectMatch('bo', [BOSS]);
    expect(result).toBeNull();
  });

  it('matches a typo-squatter with Levenshtein distance 1', () => {
    const result = detectMatch('applle', [APPLE]);
    expect(result).not.toBeNull();
    expect(result?.markName).toBe('Apple');
  });

  it('matches when the SLD contains a compound mark\'s tokens (applestore vs App Store)', () => {
    const result = detectMatch('applestore', [APP_STORE]);
    expect(result).not.toBeNull();
    expect(result?.markName).toBe('App Store');
  });

  it('does NOT match a compound mark when only one of its tokens is present (app vs App Store)', () => {
    const result = detectMatch('app', [APP_STORE]);
    expect(result).toBeNull();
  });

  it('does NOT match when the SLD overlaps a mark word but is not the same (estate vs State Farm)', () => {
    // The old substring rule matched this: "state" is contained in "estate".
    // Token policy declines because "estate" !== "state" and the lengths
    // differ by more than 1, so Levenshtein-1 also fails.
    const result = detectMatch('estate', [STATE_FARM]);
    expect(result).toBeNull();
  });

  it('matches after digit-to-word normalisation (fourchan vs Chan)', () => {
    // 4chan.com → "fourchan" → tokens [four, chan]; "chan" exact-equals
    // the mark token. Mark wins.
    const result = detectMatch('fourchan', [CHAN]);
    expect(result).not.toBeNull();
    expect(result?.markName).toBe('Chan');
  });

  it('returns the first matching mark (preserves order over the marks list)', () => {
    const result = detectMatch('nike', [APPLE, NIKE, APP_STORE]);
    expect(result?.markName).toBe('Nike');
  });
});

describe('extractSld', () => {
  it('extracts SLD from a single-part TLD', () => {
    expect(extractSld('nike.com')).toBe('nike');
  });

  it('extracts SLD from a multi-part TLD (regression: nike.co.uk → nike, not nikeco)', () => {
    expect(extractSld('nike.co.uk')).toBe('nike');
  });

  it('strips subdomain prefixes before a multi-part TLD (PSL-aware)', () => {
    // Full PSL recognises `co.uk` as the public suffix and strips
    // `shop.us` as subdomain prefixes — only `nike` is the SLD.
    expect(extractSld('shop.us.nike.co.uk')).toBe('nike');
  });

  it('extracts SLD from a 3-label domain with single-part TLD', () => {
    // `company.io` is the registered domain; `other` is a subdomain.
    expect(extractSld('other.company.io')).toBe('company');
  });

  it('returns domain unchanged if no dot', () => {
    expect(extractSld('nodot')).toBe('nodot');
  });

  it('returns empty string for empty input', () => {
    expect(extractSld('')).toBe('');
  });
});
