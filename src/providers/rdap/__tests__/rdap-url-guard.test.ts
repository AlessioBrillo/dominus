// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { isPrivateIpAddress, assertPublicHttpsUrl } from '../rdap-url-guard.js';

describe('isPrivateIpAddress', () => {
  it('flags RFC 1918, loopback and link-local IPv4 ranges', () => {
    expect(isPrivateIpAddress('10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('10.255.255.255')).toBe(true);
    expect(isPrivateIpAddress('172.16.0.1')).toBe(true);
    expect(isPrivateIpAddress('172.31.255.255')).toBe(true);
    expect(isPrivateIpAddress('192.168.1.1')).toBe(true);
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('169.254.169.254')).toBe(true);
  });

  it('keeps public IPv4 ranges unflagged', () => {
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false);
    expect(isPrivateIpAddress('93.184.216.34')).toBe(false);
    expect(isPrivateIpAddress('172.32.0.1')).toBe(false);
  });

  it('flags loopback, unique-local and link-local IPv6', () => {
    expect(isPrivateIpAddress('::1')).toBe(true);
    expect(isPrivateIpAddress('::')).toBe(true);
    expect(isPrivateIpAddress('fd00::1')).toBe(true);
    expect(isPrivateIpAddress('fc00::1')).toBe(true);
    expect(isPrivateIpAddress('fe80::1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:10.1.2.3')).toBe(true);
  });

  it('keeps public IPv6 unflagged', () => {
    expect(isPrivateIpAddress('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpAddress('2606:4700::1111')).toBe(false);
  });
});

describe('assertPublicHttpsUrl', () => {
  const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];

  it('accepts an https URL on a public hostname', async () => {
    await expect(
      assertPublicHttpsUrl('https://rdap.verisign.com/com/v1/domain/x.com', publicLookup),
    ).resolves.toBeUndefined();
  });

  it('refuses plain http redirects', async () => {
    await expect(
      assertPublicHttpsUrl('http://rdap.verisign.com/domain/x.com', publicLookup),
    ).rejects.toThrow(/https/i);
  });

  it('refuses a hostname resolving to a private address', async () => {
    await expect(
      assertPublicHttpsUrl('https://evil.example/domain/x.com', async () => ['10.0.0.7']),
    ).rejects.toThrow(/private/i);
  });

  it('refuses a private IP-literal host without consulting DNS', async () => {
    const lookup = vi.fn(publicLookup);
    await expect(assertPublicHttpsUrl('https://127.0.0.1/domain/x.com', lookup)).rejects.toThrow(
      /private/i,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed when the hostname cannot be resolved', async () => {
    await expect(
      assertPublicHttpsUrl('https://nonexistent.invalid/domain/x.com', async () => {
        throw new Error('NXDOMAIN');
      }),
    ).rejects.toThrow();
  });

  it('fails closed when the hostname resolves to no addresses', async () => {
    await expect(
      assertPublicHttpsUrl('https://empty.example/domain/x.com', async () => []),
    ).rejects.toThrow();
  });

  it('rejects a non-URL redirect target', async () => {
    await expect(assertPublicHttpsUrl('not a url', publicLookup)).rejects.toThrow();
  });
});
