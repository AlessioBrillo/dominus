// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { checkTrustProxyGuard } from '../boot-guards.js';

describe('checkTrustProxyGuard', () => {
  it('warns when TRUST_PROXY_DEPTH is unset', () => {
    const guard = checkTrustProxyGuard(null);
    expect(guard).not.toBeNull();
    expect(guard!.severity).toBe('warn');
    expect(guard!.code).toBe('TRUST_PROXY_UNSET');
  });

  it('explains both failure directions, not just the missing value', () => {
    const guard = checkTrustProxyGuard(null)!;
    // Keying on the proxy throttles everyone as one caller; a wrong-but-set
    // value trusts a client-supplied header. Both belong in the message,
    // because the operator has to pick a number and needs to know what goes
    // wrong in each direction.
    expect(guard.message).toContain('per-IP rate limit');
    expect(guard.message).toContain('proxy hops');
  });

  it('names the residual gap the guard does not close', () => {
    // Documented in the module: this does not make the protected-router
    // limiter shared across replicas. The message must say so, or an
    // operator could reasonably believe setting the depth fixes scaling.
    const guard = checkTrustProxyGuard(null)!;
    expect(guard.message).toContain('in-process');
  });

  it('is silent when a depth is configured, including zero', () => {
    // 0 is a legitimate answer: no proxy, trust the socket address.
    expect(checkTrustProxyGuard(0)).toBeNull();
    expect(checkTrustProxyGuard(1)).toBeNull();
    expect(checkTrustProxyGuard(2)).toBeNull();
    expect(checkTrustProxyGuard(10)).toBeNull();
  });
});
