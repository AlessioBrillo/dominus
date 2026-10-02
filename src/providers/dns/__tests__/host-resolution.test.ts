// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHostPort, resolveUnboundHosts } from '../host-resolution.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe('parseHostPort', () => {
  it('parses a bare IP', () => {
    expect(parseHostPort('127.0.0.1')).toEqual({ host: '127.0.0.1' });
  });

  it('parses an IP with port', () => {
    expect(parseHostPort('127.0.0.1:5300')).toEqual({ host: '127.0.0.1', port: 5300 });
  });

  it('parses a hostname with port', () => {
    expect(parseHostPort('unbound:5300')).toEqual({ host: 'unbound', port: 5300 });
  });

  it('parses bracketed IPv6 with port', () => {
    expect(parseHostPort('[::1]:5300')).toEqual({ host: '::1', port: 5300 });
  });

  it('parses bare IPv6 without port', () => {
    expect(parseHostPort('::1')).toEqual({ host: '::1' });
  });

  it('rejects empty entries', () => {
    expect(() => parseHostPort('')).toThrow(/Invalid Unbound host entry/);
    expect(() => parseHostPort('   ')).toThrow(/Invalid Unbound host entry/);
  });

  it('rejects non-numeric ports', () => {
    expect(() => parseHostPort('unbound:abc')).toThrow(/Invalid Unbound host entry/);
  });
});

describe('resolveUnboundHosts', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it('passes IP literals through untouched', async () => {
    const resolved = await resolveUnboundHosts(['127.0.0.1', '10.0.0.1:5300', '[::1]:5300']);
    expect(resolved).toEqual(['127.0.0.1', '10.0.0.1:5300', '[::1]:5300']);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('resolves a compose service name to its IP, preserving the port', async () => {
    mockLookup.mockResolvedValue({ address: '172.21.0.10', family: 4 });
    const resolved = await resolveUnboundHosts(['unbound:5300']);
    expect(mockLookup).toHaveBeenCalledWith('unbound');
    expect(resolved).toEqual(['172.21.0.10:5300']);
  });

  it('brackets a resolved IPv6 address', async () => {
    mockLookup.mockResolvedValue({ address: 'fd00::2', family: 6 });
    const resolved = await resolveUnboundHosts(['unbound']);
    expect(resolved).toEqual(['[fd00::2]']);
  });

  it('fails closed when a hostname does not resolve', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND unbound'));
    await expect(resolveUnboundHosts(['unbound:5300'])).rejects.toThrow(
      /Cannot resolve Unbound host 'unbound'/,
    );
    expect(mockLookup).toHaveBeenCalledTimes(3);
  });

  it('retries transient resolution failures before failing closed', async () => {
    mockLookup
      .mockRejectedValueOnce(Object.assign(new Error('EAI_AGAIN unbound'), { code: 'EAI_AGAIN' }))
      .mockResolvedValueOnce({ address: '172.21.0.10', family: 4 });
    const resolved = await resolveUnboundHosts(['unbound:5300']);
    expect(resolved).toEqual(['172.21.0.10:5300']);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });
});
