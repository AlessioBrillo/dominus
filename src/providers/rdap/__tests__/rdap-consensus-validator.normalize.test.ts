// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  normalizeRdapOrigin,
  rdapUrlOrigin,
  hasAuthoritativeOriginOverlap,
  hasWinningOriginOverlap,
  validateRdapConsensusOriginDisjointness,
} from '../rdap-consensus-validator.js';

describe('RDAP consensus origin normalization', () => {
  describe('normalizeRdapOrigin', () => {
    it('strips trailing slash', () => {
      expect(normalizeRdapOrigin('https://rdap.verisign.com/')).toBe('https://rdap.verisign.com');
    });

    it('removes default port 443 for https', () => {
      expect(normalizeRdapOrigin('https://rdap.verisign.com:443')).toBe('https://rdap.verisign.com');
    });

    it('removes default port 80 for http', () => {
      expect(normalizeRdapOrigin('http://rdap.example.com:80')).toBe('http://rdap.example.com');
    });

    it('preserves non-default ports', () => {
      expect(normalizeRdapOrigin('https://rdap.example.com:8443')).toBe('https://rdap.example.com:8443');
    });

    it('normalizes IPv6 bracket notation', () => {
      expect(normalizeRdapOrigin('https://[::1]:5300')).toBe('https://[::1]:5300');
      expect(normalizeRdapOrigin('https://[2001:db8::1]:443')).toBe('https://[2001:db8::1]');
    });

    it('lowercases hostname', () => {
      expect(normalizeRdapOrigin('https://RDAP.VERISIGN.COM')).toBe('https://rdap.verisign.com');
      expect(normalizeRdapOrigin('https://RdAp.VeRiSiGn.CoM:443')).toBe('https://rdap.verisign.com');
    });

    it('handles mixed case with trailing slash and default port', () => {
      expect(normalizeRdapOrigin('https://RDAP.EXAMPLE.COM:443/')).toBe('https://rdap.example.com');
    });

    it('returns undefined for unparsable URLs', () => {
      expect(normalizeRdapOrigin('not-a-url')).toBeUndefined();
      expect(normalizeRdapOrigin('')).toBeUndefined();
    });

    it('handles URLs with path', () => {
      expect(normalizeRdapOrigin('https://rdap.verisign.com/domain/')).toBe('https://rdap.verisign.com');
      expect(normalizeRdapOrigin('https://rdap.verisign.com/domain/example.com')).toBe('https://rdap.verisign.com');
    });
  });

  describe('rdapUrlOrigin', () => {
    it('delegates to normalizeRdapOrigin', () => {
      expect(rdapUrlOrigin('https://rdap.verisign.com/')).toBe('https://rdap.verisign.com');
      expect(rdapUrlOrigin('https://rdap.verisign.com:443')).toBe('https://rdap.verisign.com');
    });
  });

  describe('hasAuthoritativeOriginOverlap', () => {
    it('detects overlap with trailing slash difference', () => {
      const authoritative = ['https://rdap.verisign.com/'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'https://rdap.verisign.com')).toBe(true);
    });

    it('detects overlap with explicit default port', () => {
      const authoritative = ['https://rdap.verisign.com:443'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'https://rdap.verisign.com')).toBe(true);
    });

    it('detects overlap with case difference', () => {
      const authoritative = ['https://RDAP.VERISIGN.COM'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'https://rdap.verisign.com')).toBe(true);
    });

    it('detects overlap with IPv6 bracket notation', () => {
      const authoritative = ['https://[::1]:5300/'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'https://[::1]:5300')).toBe(true);
    });

    it('returns false for no overlap', () => {
      const authoritative = ['https://rdap.verisign.com'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'https://rdap.org')).toBe(false);
    });

    it('returns false for unparsable secondary', () => {
      const authoritative = ['https://rdap.verisign.com'];
      expect(hasAuthoritativeOriginOverlap(authoritative, 'not-a-url')).toBe(false);
    });
  });

  describe('hasWinningOriginOverlap', () => {
    it('detects overlap with trailing slash difference', () => {
      expect(hasWinningOriginOverlap('https://rdap.verisign.com/', 'https://rdap.verisign.com')).toBe(true);
    });

    it('detects overlap with explicit default port', () => {
      expect(hasWinningOriginOverlap('https://rdap.verisign.com:443', 'https://rdap.verisign.com')).toBe(true);
    });

    it('detects overlap with case difference', () => {
      expect(hasWinningOriginOverlap('https://RDAP.VERISIGN.COM', 'https://rdap.verisign.com')).toBe(true);
    });

    it('returns false for no overlap', () => {
      expect(hasWinningOriginOverlap('https://rdap.verisign.com', 'https://rdap.org')).toBe(false);
    });

    it('returns false for undefined primary origin', () => {
      expect(hasWinningOriginOverlap(undefined, 'https://rdap.verisign.com')).toBe(false);
    });

    it('returns false for unparsable secondary', () => {
      expect(hasWinningOriginOverlap('https://rdap.verisign.com', 'not-a-url')).toBe(false);
    });
  });

  describe('validateRdapConsensusOriginDisjointness', () => {
    it('returns ok=true for disjoint origins', () => {
      const result = validateRdapConsensusOriginDisjointness(
        ['https://rdap.verisign.com'],
        'https://rdap.org',
      );
      expect(result.ok).toBe(true);
    });

    it('returns ok=false for overlapping origins with trailing slash', () => {
      const result = validateRdapConsensusOriginDisjointness(
        ['https://rdap.verisign.com/'],
        'https://rdap.verisign.com',
      );
      expect(result.ok).toBe(false);
      expect(result.overlap).toBe('https://rdap.verisign.com');
    });

    it('returns ok=false for overlapping origins with explicit port', () => {
      const result = validateRdapConsensusOriginDisjointness(
        ['https://rdap.verisign.com:443'],
        'https://rdap.verisign.com',
      );
      expect(result.ok).toBe(false);
      expect(result.overlap).toBe('https://rdap.verisign.com');
    });

    it('returns ok=false for unparsable secondary', () => {
      const result = validateRdapConsensusOriginDisjointness(
        ['https://rdap.verisign.com'],
        'not-a-url',
      );
      expect(result.ok).toBe(false);
      expect(result.overlap).toBe('not-a-url');
    });
  });
});