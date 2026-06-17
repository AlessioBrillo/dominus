import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetryingRdapProvider, CircuitOpenError } from '../retrying-rdap-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import { DomainStatus } from '../../types/domain-status.js';

function makeProvider(impl: RdapProvider['confirm']): RdapProvider {
  return { name: 'test-rdap', confirm: impl };
}

function okResult(domain = 'example.com'): RdapResult {
  return {
    domain,
    status: DomainStatus.Available,
    isPremium: false,
    checkedAt: new Date().toISOString(),
  };
}

import type { RdapResult } from '../../types/domain-status.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RetryingRdapProvider', () => {
  it('returns the first successful result without retrying', async () => {
    const delegate = makeProvider(vi.fn().mockResolvedValue(okResult()));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(delegate, { sleep });

    const out = await provider.confirm('example.com');

    expect(out.status).toBe(DomainStatus.Available);
    expect(delegate.confirm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on transient errors and eventually returns success', async () => {
    const delegate = makeProvider(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('upstream 503'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(okResult()),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(delegate, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
    });

    const out = await provider.confirm('example.com');

    expect(out.status).toBe(DomainStatus.Available);
    expect(delegate.confirm).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-transient errors (no retry)', async () => {
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('400 Bad Request')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(delegate, { sleep });

    await expect(provider.confirm('example.com')).rejects.toThrow('400 Bad Request');
    expect(delegate.confirm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('503 upstream down')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(delegate, {
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
      sleep,
    });

    await expect(provider.confirm('example.com')).rejects.toThrow('503 upstream down');
    expect(delegate.confirm).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('respects baseDelayMs + backoffMultiplier when computing delays', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(
      makeProvider(vi.fn().mockRejectedValue(new Error('503'))),
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1_000_000,
        jitterRatio: 0,
        random: (): number => 0,
        sleep,
      },
    );

    await expect(provider.confirm('example.com')).rejects.toThrow('503');

    expect(sleep.mock.calls.map((c): number => c[0] as number)).toEqual([100, 200, 400]);
  });

  it('caps delay at maxDelayMs', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(
      makeProvider(vi.fn().mockRejectedValue(new Error('503'))),
      {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        backoffMultiplier: 10,
        maxDelayMs: 500,
        jitterRatio: 0,
        random: (): number => 0,
        sleep,
      },
    );

    await expect(provider.confirm('example.com')).rejects.toThrow('503');

    expect(sleep.mock.calls.map((c): number => c[0] as number)).toEqual([500, 500]);
  });

  it('opens circuit after failureThreshold transient failures', async () => {
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('503')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(
      delegate,
      { maxAttempts: 1, sleep },
      { failureThreshold: 3, windowMs: 60_000, cooldownMs: 120_000 },
    );

    await expect(provider.confirm('example.com')).rejects.toThrow('503');
    await expect(provider.confirm('example.com')).rejects.toThrow('503');
    await expect(provider.confirm('example.com')).rejects.toThrow('503');

    await expect(provider.confirm('example.com')).rejects.toThrow(CircuitOpenError);
  });

  it('re-closes circuit after transient failure below threshold', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(okResult());
    const delegate = makeProvider(mock);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(
      delegate,
      { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, sleep },
      { failureThreshold: 5, windowMs: 60_000, cooldownMs: 120_000 },
    );

    await expect(provider.confirm('example.com')).rejects.toThrow('503');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);

    sleep.mockClear();

    const out = await provider.confirm('example.com');
    expect(out.status).toBe(DomainStatus.Available);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rethrows CircuitOpenError immediately without counting as failure', async () => {
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('503')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingRdapProvider(
      delegate,
      { maxAttempts: 1, sleep },
      { failureThreshold: 1, windowMs: 60_000, cooldownMs: 120_000 },
    );

    await expect(provider.confirm('example.com')).rejects.toThrow('503');
    const err1 = await provider.confirm('example.com').catch((e) => e);
    expect(err1).toBeInstanceOf(CircuitOpenError);
    expect(delegate.confirm).toHaveBeenCalledTimes(1);
  });

  it('exposes name via property', () => {
    const delegate = makeProvider(vi.fn());
    const provider = new RetryingRdapProvider(delegate);
    expect(provider.name).toBe('RetryingRdapProvider(test-rdap)');
  });
});
