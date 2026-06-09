import { describe, it, expect, vi } from 'vitest';
import {
  RetryingTrademarkProvider,
  isTransient,
  DEFAULT_RETRY_POLICY,
} from '../retrying-trademark-provider.js';
import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../../providers/trademark/trademark-provider.js';

function makeProvider(impl: TrademarkProvider['search']): TrademarkProvider {
  return { search: impl };
}

function match(name: string): TrademarkMatch {
  return { markName: name, owner: 'Acme', status: 'live', source: 'USPTO' };
}

describe('RetryingTrademarkProvider', () => {
  describe('isTransient', () => {
    it('flags HTTP 5xx, 429, and network errors as transient', () => {
      expect(isTransient(new Error('upstream 503 Service Unavailable'))).toBe(true);
      expect(isTransient(new Error('429 Too Many Requests'))).toBe(true);
      expect(isTransient(new Error('502 Bad Gateway'))).toBe(true);
      expect(isTransient(new Error('ECONNRESET'))).toBe(true);
      expect(isTransient(new Error('fetch failed'))).toBe(true);
      expect(isTransient(new Error('request timeout'))).toBe(true);
    });

    it('does not flag well-formed 4xx as transient', () => {
      expect(isTransient(new Error('400 Bad Request'))).toBe(false);
      expect(isTransient(new Error('404 Not Found'))).toBe(false);
      expect(isTransient(new Error('unauthorized'))).toBe(false);
    });

    it('flags transient via numeric status property', () => {
      expect(isTransient(Object.assign(new Error('upstream error'), { status: 503 }))).toBe(true);
      expect(isTransient(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    });

    it('does not flag non-transient status codes', () => {
      expect(isTransient(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
      expect(isTransient(Object.assign(new Error('forbidden'), { status: 403 }))).toBe(false);
    });

    it('flags transient via system code property', () => {
      expect(
        isTransient(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })),
      ).toBe(true);
      expect(
        isTransient(Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' })),
      ).toBe(true);
      expect(isTransient(Object.assign(new Error('DNS not found'), { code: 'ENOTFOUND' }))).toBe(
        true,
      );
    });

    it('walks cause chain for wrapped transient errors', () => {
      const inner = Object.assign(new Error('underlying'), { status: 502 });
      const outer = new Error('wrapper', { cause: inner });
      expect(isTransient(outer)).toBe(true);
    });

    it('uses word-boundary matching on message to avoid false positives', () => {
      expect(isTransient(new Error('error 4290'))).toBe(false);
      expect(isTransient(new Error('status 9429'))).toBe(false);
      expect(isTransient(new Error('port 5000'))).toBe(false);
    });
  });

  it('returns the first successful result without retrying', async () => {
    // Arrange
    const delegate = makeProvider(vi.fn().mockResolvedValue([match('alpha')]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(delegate, { sleep });

    // Act
    const out = await provider.search('alpha');

    // Assert
    expect(out).toEqual([match('alpha')]);
    expect(delegate.search).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on transient errors and eventually returns success', async () => {
    // Arrange
    const delegate = makeProvider(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('upstream 503'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce([match('alpha')]),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(delegate, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
    });

    // Act
    const out = await provider.search('alpha');

    // Assert
    expect(out).toEqual([match('alpha')]);
    expect(delegate.search).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-transient errors (no retry)', async () => {
    // Arrange
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('400 Bad Request')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(delegate, { sleep });

    // Act + Assert
    await expect(provider.search('alpha')).rejects.toThrow('400 Bad Request');
    expect(delegate.search).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    // Arrange
    const delegate = makeProvider(vi.fn().mockRejectedValue(new Error('503 upstream down')));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(delegate, {
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
      sleep,
    });

    // Act + Assert
    await expect(provider.search('alpha')).rejects.toThrow('503 upstream down');
    expect(delegate.search).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // 3 attempts → 2 sleeps
  });

  it('respects baseDelayMs + backoffMultiplier when computing delays', async () => {
    // Arrange
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(
      makeProvider(vi.fn().mockRejectedValue(new Error('503'))),
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1_000_000,
        jitterRatio: 0, // disable jitter to make delays deterministic
        random: (): number => 0,
        sleep,
      },
    );

    // Act
    await expect(provider.search('alpha')).rejects.toThrow('503');

    // Assert — delays should be 100, 200, 400 (jitter=0 → just base * mult^(attempt-1))
    expect(sleep.mock.calls.map((c): number => c[0] as number)).toEqual([100, 200, 400]);
  });

  it('caps delay at maxDelayMs', async () => {
    // Arrange
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = new RetryingTrademarkProvider(
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

    // Act
    await expect(provider.search('alpha')).rejects.toThrow('503');

    // Assert
    expect(sleep.mock.calls.map((c): number => c[0] as number)).toEqual([500, 500]);
  });

  it('uses default policy when none is provided', () => {
    // Assert — defaults are sane (constructibility is the only contract)
    new RetryingTrademarkProvider(makeProvider(vi.fn()));
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(10_000);
  });
});
