import { describe, it, expect } from 'vitest';
import { isValidDomain } from '../domain.js';

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
