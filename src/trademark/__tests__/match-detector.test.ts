import { describe, it, expect } from 'vitest';
import { detectMatch, extractSld } from '../match-detector.js';
import type { MatchCandidate } from '../match-detector.js';

const NIKE: MatchCandidate = { markName: 'Nike', owner: 'Nike Inc.', status: 'registered', source: 'uspto' };
const APPLE: MatchCandidate = { markName: 'Apple', owner: 'Apple Inc.', status: 'registered', source: 'uspto' };

describe('detectMatch', () => {
  it('exact match is detected (case-insensitive)', () => {
    const result = detectMatch('nike', [NIKE]);
    expect(result).not.toBeNull();
    expect(result?.markName).toBe('Nike');
  });

  it('substring match is detected', () => {
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
});

describe('extractSld', () => {
  it('extracts SLD from single TLD', () => {
    expect(extractSld('nike.com')).toBe('nike');
  });

  it('extracts SLD from multi-part TLD', () => {
    expect(extractSld('nike.co.uk')).toBe('nikeco');
  });

  it('returns domain unchanged if no dot', () => {
    expect(extractSld('nodot')).toBe('nodot');
  });
});
