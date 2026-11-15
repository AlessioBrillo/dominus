// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { isPubliclyRoutableHost } from '../public-host.js';

/**
 * The webhook URL of a tenant is fetched by the SERVER: the check below is
 * what keeps a customer from making the platform POST to the loopback, to a
 * private range or to the cloud metadata service.
 */
describe('isPubliclyRoutableHost', () => {
  it('accepts public names and addresses', () => {
    expect(isPubliclyRoutableHost('hooks.example.com')).toBe(true);
    expect(isPubliclyRoutableHost('example.co.uk')).toBe(true);
    expect(isPubliclyRoutableHost('8.8.8.8')).toBe(true);
    expect(isPubliclyRoutableHost('2606:4700:4700::1111')).toBe(true);
  });

  it('refuses the loopback and the unspecified address', () => {
    expect(isPubliclyRoutableHost('localhost')).toBe(false);
    expect(isPubliclyRoutableHost('app.localhost')).toBe(false);
    expect(isPubliclyRoutableHost('127.0.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('127.9.9.9')).toBe(false);
    expect(isPubliclyRoutableHost('0.0.0.0')).toBe(false);
    expect(isPubliclyRoutableHost('[::1]')).toBe(false);
    expect(isPubliclyRoutableHost('::')).toBe(false);
  });

  it('refuses the private ranges', () => {
    expect(isPubliclyRoutableHost('10.0.0.5')).toBe(false);
    expect(isPubliclyRoutableHost('172.16.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('172.31.255.255')).toBe(false);
    expect(isPubliclyRoutableHost('192.168.1.10')).toBe(false);
    expect(isPubliclyRoutableHost('fd00::1')).toBe(false);
    expect(isPubliclyRoutableHost('fc12::1')).toBe(false);
    // A 172.x address outside 172.16/12 is public.
    expect(isPubliclyRoutableHost('172.32.0.1')).toBe(true);
  });

  it('refuses link-local and carrier-grade NAT', () => {
    expect(isPubliclyRoutableHost('169.254.169.254')).toBe(false);
    expect(isPubliclyRoutableHost('fe80::1')).toBe(false);
    expect(isPubliclyRoutableHost('100.64.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('100.128.0.1')).toBe(true);
  });

  it('refuses an IPv4 address mapped into IPv6 when it is private', () => {
    expect(isPubliclyRoutableHost('::ffff:127.0.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('::ffff:8.8.8.8')).toBe(true);
  });

  it('refuses a single-label internal name', () => {
    expect(isPubliclyRoutableHost('intranet')).toBe(false);
    expect(isPubliclyRoutableHost('metadata')).toBe(false);
  });
});
