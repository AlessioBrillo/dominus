// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { hasAuthoritativeOriginOverlap } from '../rdap-consensus-validator.js';

describe('hasAuthoritativeOriginOverlap (ADR-0058)', () => {
  it('flags the second endpoint when it is authoritative for the TLD', () => {
    expect(
      hasAuthoritativeOriginOverlap(['https://rdap.verisign.com/'], 'https://rdap.verisign.com/'),
    ).toBe(true);
  });

  it('passes when the second endpoint is not authoritative for the TLD', () => {
    expect(
      hasAuthoritativeOriginOverlap(['https://rdap.verisign.com/'], 'https://rdap.org/'),
    ).toBe(false);
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
