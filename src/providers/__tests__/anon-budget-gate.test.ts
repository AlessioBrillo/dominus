// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { AnonBudgetGate } from '../anon-budget-gate.js';
import { RateLimiter, RateLimiterQueueFullError } from '../rate-limiter.js';
import type { RateLimiterLike } from '../rate-limiter.js';

describe('AnonBudgetGate (ADR-0056)', () => {
  it('grants every attempt when disabled', async () => {
    const limiter = new RateLimiter({
      maxTokens: 1,
      tokensPerInterval: 1,
      intervalMs: 1_000_000,
    });
    const gate = new AnonBudgetGate(limiter, { enabled: false, acquireTimeoutMs: 50 });

    await expect(gate.tryAcquire()).resolves.toBe(true);
    await expect(gate.tryAcquire()).resolves.toBe(true);
    expect(gate.enabled).toBe(false);
  });

  it('grants when a token is available', async () => {
    const limiter = new RateLimiter({
      maxTokens: 2,
      tokensPerInterval: 2,
      intervalMs: 1_000_000,
    });
    const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 100 });

    await expect(gate.tryAcquire()).resolves.toBe(true);
    expect(gate.enabled).toBe(true);
  });

  it('fails open when the budget is exhausted beyond the acquire timeout', async () => {
    const limiter = new RateLimiter({
      maxTokens: 1,
      tokensPerInterval: 1,
      intervalMs: 1000,
    });
    const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 150 });

    await expect(gate.tryAcquire()).resolves.toBe(true);
    await expect(gate.tryAcquire()).resolves.toBe(false);
  });

  it('fails open when the limiter queue is full', async () => {
    const limiter: RateLimiterLike = {
      maxTokens: 1,
      acquire: vi.fn().mockRejectedValue(new RateLimiterQueueFullError(1, 1)),
      throttle: vi.fn(),
    };
    const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 50 });

    await expect(gate.tryAcquire()).resolves.toBe(false);
  });

  it('fails open when the limiter stalls and never grants a token', async () => {
    const limiter: RateLimiterLike = {
      maxTokens: 1,
      acquire: () => new Promise(() => {}),
      throttle: vi.fn(),
    };
    const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 50 });

    await expect(gate.tryAcquire()).resolves.toBe(false);
  });

  it('fails open when the limiter rejects with an unexpected error', async () => {
    const limiter: RateLimiterLike = {
      maxTokens: 1,
      acquire: vi.fn().mockRejectedValue(new Error('redis down')),
      throttle: vi.fn(),
    };
    const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 50 });

    await expect(gate.tryAcquire()).resolves.toBe(false);
  });
});