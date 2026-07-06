import { describe, it, expect } from 'vitest';
import { normalizeDomain, isValidDomain, getSldForTrademark } from '../domain-validator.js';

describe('normalizeDomain', () => {
  it('normalises a vanilla ASCII domain', () => {
    const r = normalizeDomain('Example.COM');
    expect(r.isValid).toBe(true);
    expect(r.normalized).toBe('example.com');
    expect(r.sld).toBe('example');
    expect(r.tld).toBe('.com');
    expect(r.sldUnicode).toBe('example');
  });

  it('strips BOM character', () => {
    const r = normalizeDomain('\uFEFFexample.com');
    expect(r.isValid).toBe(true);
    expect(r.normalized).toBe('example.com');
  });

  it('trims whitespace', () => {
    const r = normalizeDomain('  example.com  ');
    expect(r.isValid).toBe(true);
    expect(r.normalized).toBe('example.com');
  });

  it('converts IDN to punycode', () => {
    const r = normalizeDomain('münchen.de');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('xn--mnchen-3ya');
  });

  it('preserves unicode SLD for trademark use', () => {
    const r = normalizeDomain('münchen.de');
    expect(r.isValid).toBe(true);
    expect(r.sldUnicode).toBe('münchen');
  });

  it('rejects empty input', () => {
    const r = normalizeDomain('');
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('empty domain');
  });

  it('rejects whitespace-only input', () => {
    const r = normalizeDomain('   ');
    expect(r.isValid).toBe(false);
  });

  it('rejects domains with leading hyphen per label', () => {
    const r = normalizeDomain('-bad.com');
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toContain('hyphen');
  });

  it('rejects domains with trailing hyphen per label', () => {
    const r = normalizeDomain('bad-.com');
    expect(r.isValid).toBe(false);
  });

  it('rejects domains with invalid characters', () => {
    const r = normalizeDomain('spaces in domain.com');
    expect(r.isValid).toBe(false);
  });

  it('rejects domains with underscores', () => {
    const r = normalizeDomain('bad_name.com');
    expect(r.isValid).toBe(false);
  });

  it('rejects single-label input', () => {
    const r = normalizeDomain('notld');
    expect(r.isValid).toBe(false);
  });

  it('rejects domain with label > 63 chars', () => {
    const r = normalizeDomain(`${'a'.repeat(64)}.com`);
    expect(r.isValid).toBe(false);
  });

  it('rejects domain longer than 253 chars', () => {
    const label = 'a'.repeat(63);
    const manyLabels = Array.from({ length: 5 }, () => label).join('.') + '.com';
    expect(manyLabels.length).toBeGreaterThan(253);
    const r = normalizeDomain(manyLabels);
    expect(r.isValid).toBe(false);
  });

  it('handles subdomain prefix correctly', () => {
    const r = normalizeDomain('sub.domain.com');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('domain');
    expect(r.tld).toBe('.com');
  });

  it('handles multi-part ccTLD', () => {
    const r = normalizeDomain('nike.co.uk');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('nike');
    expect(r.tld).toBe('.co.uk');
  });

  it('handles numeric SLD', () => {
    const r = normalizeDomain('123.com');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('123');
  });

  it('handles hyphenated SLD', () => {
    const r = normalizeDomain('foo-bar.com');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('foo-bar');
  });

  it('handles IDN CJK domain', () => {
    const r = normalizeDomain('例子.测试');
    expect(r.isValid).toBe(true);
  });

  it('previous trademark bypass scenario: IDN with TM conflict', () => {
    const r = normalizeDomain('xn--mgba3a4f16a.com');
    expect(r.isValid).toBe(true);
    expect(r.sld).toBe('xn--mgba3a4f16a');
    expect(r.sldUnicode).not.toBe(r.sld);
  });
});

describe('isValidDomain', () => {
  it.each([
    'example.com',
    'a.io',
    'foo-bar.com',
    'sub.example.com',
    'example.museum',
    '123numeric.com',
    'münchen.de',
    '例子.测试',
    'xn--mgba3a4f16a.com',
  ])('accepts %s', (value) => {
    expect(isValidDomain(value)).toBe(true);
  });

  it.each([
    '',
    'notld',
    '-bad.com',
    'bad-.com',
    'bad_name.com',
    'example.c',
    'a',
    'spaces in domain.com',
    'example.123',
    `${'a'.repeat(64)}.com`,
  ])('rejects %s', (value) => {
    expect(isValidDomain(value)).toBe(false);
  });
});

describe('getSldForTrademark', () => {
  it('returns unicode SLD for IDN domain', () => {
    const sld = getSldForTrademark('münchen.de');
    expect(sld).toBe('münchen');
  });

  it('returns ASCII SLD for ASCII domain', () => {
    const sld = getSldForTrademark('example.com');
    expect(sld).toBe('example');
  });

  it('returns unicode SLD from punycode input', () => {
    const sld = getSldForTrademark('xn--mnchen-3ya.de');
    expect(sld).toBe('münchen');
  });

  it('returns empty string for invalid domain', () => {
    const sld = getSldForTrademark('');
    expect(sld).toBe('');
  });
});
