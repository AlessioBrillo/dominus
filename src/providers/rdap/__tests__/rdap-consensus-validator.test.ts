// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  hasAuthoritativeOriginOverlap,
  hasWinningOriginOverlap,
} from '../rdap-consensus-validator.js';

describe('hasAuthoritativeOriginOverlap (ADR-0058)', () => {
  it('flags the second endpoint when it is authoritative for the TLD', () => {
    expect(
      hasAuthoritativeOriginOverlap(['https://rdap.verisign.com/'], 'https://rdap.verisign.com/'),
    ).toBe(true);
  });

  it('passes when the second endpoint is not authoritative for the TLD', () => {
    expect(hasAuthoritativeOriginOverlap(['https://rdap.verisign.com/'], 'https://rdap.org/')).toBe(
      false,
    );
  });

  it('passes when no authoritative origins are known (bootstrap down)', () => {
    expect(hasAuthoritativeOriginOverlap([], 'https://rdap.org/')).toBe(false);
  });

  it('never flags on an unparsable secondary endpoint (cannot prove overlap)', () => {
    expect(hasAuthoritativeOriginOverlap(['https://rdap.verisign.com/'], 'not-a-url')).toBe(false);
  });

  it('compares origins, not paths', () => {
    expect(
      hasAuthoritativeOriginOverlap(
        ['https://rdap.verisign.com/'],
        'https://rdap.verisign.com/domain/',
      ),
    ).toBe(true);
  });
});

describe('hasWinningOriginOverlap (ADR-0050 rubber-stamp guard)', () => {
  it('flags when the primary winner origin equals the second leg origin', () => {
    expect(hasWinningOriginOverlap('https://rdap.org/', 'https://rdap.org/domain/')).toBe(true);
  });

  it('passes when the primary winner origin differs from the second leg', () => {
    expect(hasWinningOriginOverlap('https://rdap.verisign.com/', 'https://rdap.org/')).toBe(false);
  });

  it('passes when the primary verdict carries no origin (WHOIS path, unknown server)', () => {
    expect(hasWinningOriginOverlap(undefined, 'https://rdap.org/')).toBe(false);
  });

  it('never flags on an unparsable primary origin', () => {
    expect(hasWinningOriginOverlap('not-a-url', 'https://rdap.org/')).toBe(false);
  });

  it('never flags on an unparsable secondary endpoint (cannot prove overlap)', () => {
    expect(hasWinningOriginOverlap('https://rdap.org/', 'not-a-url')).toBe(false);
  });
});
