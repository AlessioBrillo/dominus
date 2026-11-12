// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { isAllowedAppUrl } from '../route-utils.js';

describe('isAllowedAppUrl', () => {
  const origin = 'https://dominus.app';

  it('accepts a URL on the configured origin', () => {
    expect(isAllowedAppUrl('https://dominus.app/billing?ok=1', origin)).toBe(true);
  });

  it('accepts a URL with a different path on the configured origin', () => {
    expect(isAllowedAppUrl('https://dominus.app/terms', origin)).toBe(true);
  });

  it('refuses a lookalike host that starts with the allowed origin', () => {
    expect(isAllowedAppUrl('https://dominus.app.attacker.tld/steal', origin)).toBe(false);
  });

  it('refuses a different host', () => {
    expect(isAllowedAppUrl('https://evil.tld/steal', origin)).toBe(false);
  });

  it('refuses a different scheme on the same host', () => {
    expect(isAllowedAppUrl('http://dominus.app/billing', origin)).toBe(false);
  });

  it('refuses a different port on the same host', () => {
    expect(isAllowedAppUrl('https://dominus.app:8443/billing', origin)).toBe(false);
  });

  it('refuses a non-URL', () => {
    expect(isAllowedAppUrl('not a url', origin)).toBe(false);
  });

  it('accepts anything when no origin is configured', () => {
    expect(isAllowedAppUrl('https://whatever.tld', undefined)).toBe(true);
    expect(isAllowedAppUrl('https://whatever.tld', '')).toBe(true);
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(isAllowedAppUrl('https://dominus.app/billing', 'https://dominus.app/')).toBe(true);
  });
});
