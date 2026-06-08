import { describe, it, expect } from 'vitest';
import { isValidDomain, parseDomain, extractTld, extractSld } from '../domain.js';

describe('isValidDomain', () => {
  it.each([
    'example.com',
    'a.io',
    'foo-bar.com',
    'sub.example.com',
    'a-b-c.example.org',
    'example.museum',
    '123numeric.com',
    'with-hyphen.com',
    'UPPERCASE.COM',
  ])('accepts %s', (value) => {
    expect(isValidDomain(value)).toBe(true);
  });

  it.each([
    '',
    'noTld',
    '-bad.com',
    'bad-.com',
    'bad_name.com',
    'example.c',
    'a',
    'toolonglabel'.repeat(20) + '.com',
    'spaces in domain.com',
    'xn--strange-utf8-€.com',
    'example.123',
  ])('rejects %s', (value) => {
    expect(isValidDomain(value)).toBe(false);
  });
});

describe('parseDomain', () => {
  describe('gTLDs', () => {
    it('parses a vanilla .com domain', () => {
      expect(parseDomain('nike.com')).toEqual({
        input: 'nike.com',
        sld: 'nike',
        tld: '.com',
      });
    });

    it('lowercases mixed-case input', () => {
      expect(parseDomain('Nike.COM')).toEqual({
        input: 'nike.com',
        sld: 'nike',
        tld: '.com',
      });
    });

    it('handles single-character SLDs', () => {
      expect(parseDomain('a.io').sld).toBe('a');
      expect(parseDomain('a.io').tld).toBe('.io');
    });

    it('handles numeric SLDs', () => {
      expect(parseDomain('123.com')).toEqual({
        input: '123.com',
        sld: '123',
        tld: '.com',
      });
    });

    it('returns .com as a safe default for malformed input', () => {
      expect(parseDomain('notld').tld).toBe('.com');
    });
  });

  describe('multi-part ccTLDs (the bug)', () => {
    it('treats nike.co.uk as sld=nike, tld=.co.uk', () => {
      expect(parseDomain('nike.co.uk')).toEqual({
        input: 'nike.co.uk',
        sld: 'nike',
        tld: '.co.uk',
      });
    });

    it('treats foo.com.au as sld=foo, tld=.com.au', () => {
      expect(parseDomain('foo.com.au')).toEqual({
        input: 'foo.com.au',
        sld: 'foo',
        tld: '.com.au',
      });
    });

    it('treats a.ne.jp as sld=a, tld=.ne.jp', () => {
      expect(parseDomain('a.ne.jp')).toEqual({
        input: 'a.ne.jp',
        sld: 'a',
        tld: '.ne.jp',
      });
    });

    it('treats a deeply nested ac.uk as sld=a, tld=.ac.uk', () => {
      expect(parseDomain('oxford.ac.uk').sld).toBe('oxford');
      expect(parseDomain('oxford.ac.uk').tld).toBe('.ac.uk');
    });

    it('strips subdomain prefixes correctly with full PSL', () => {
      // `sub.domain.com` — PSL recognises `.com` as the TLD,
      // strips `sub` as a subdomain, returns `domain` as the SLD.
      expect(parseDomain('sub.domain.com')).toEqual({
        input: 'sub.domain.com',
        sld: 'domain',
        tld: '.com',
      });
    });
  });

  describe('empty / degenerate input', () => {
    it('returns empty sld and default tld for empty input', () => {
      expect(parseDomain('')).toEqual({ input: '', sld: '', tld: '.com' });
    });

    it('returns empty sld and default tld for whitespace-only input', () => {
      expect(parseDomain('   ')).toEqual({ input: '', sld: '', tld: '.com' });
    });
  });
});

describe('extractTld / extractSld convenience wrappers', () => {
  it('extractTld returns the TLD for a vanilla domain', () => {
    expect(extractTld('nike.com')).toBe('.com');
  });

  it('extractTld returns the multi-part TLD when applicable', () => {
    expect(extractTld('nike.co.uk')).toBe('.co.uk');
    expect(extractTld('foo.com.au')).toBe('.com.au');
  });

  it('extractSld returns the SLD for a vanilla domain', () => {
    expect(extractSld('nike.com')).toBe('nike');
  });

  it('extractSld returns the SLD correctly for multi-part TLDs', () => {
    expect(extractSld('nike.co.uk')).toBe('nike');
    expect(extractSld('foo.com.au')).toBe('foo');
  });

  it('extractSld on empty input returns empty string', () => {
    expect(extractSld('')).toBe('');
  });
});
