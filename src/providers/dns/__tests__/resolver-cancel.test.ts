// SPDX-License-Identifier: AGPL-3.0-only
// The lookup helpers share the caller's Resolver when one is supplied (a
// cached per-nameserver-set instance, see #cachedResolver) and must NEVER
// cancel it — cancel() kills every outstanding query on that resolver. On
// the no-resolver path the helpers own a per-call Resolver and must cancel
// it on timeout/abort so a hung upstream cannot leave sockets churning.
// This suite replaces node:dns Resolver with a never-answering mock to make
// the hang deterministic and offline.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Resolver } from 'node:dns';
import { resolveWithTimeout, resolveWithAbort } from '../node-dns-provider.js';

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  class MockResolver {
    static instances: MockResolver[] = [];
    cancelled = false;
    constructor() {
      MockResolver.instances.push(this);
    }
    resolve(
      _hostname: string,
      _rrtype: string,
      _callback: (err: Error | null, addresses?: string[]) => void,
    ): void {
      // Never answers: simulates an upstream nameserver that hangs.
    }
    cancel(): void {
      this.cancelled = true;
    }
    setServers(_servers: string[]): void {}
  }
  return { ...actual, Resolver: MockResolver };
});

interface MockResolverType extends Resolver {
  cancelled: boolean;
}

describe('per-call resolver cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Resolver as unknown as { instances: MockResolver[] }).instances = [];
  });

  it('cancels the owned resolver when the timeout fires', async () => {
    const promise = resolveWithTimeout('hung.test', 'A', 50);
    await expect(promise).rejects.toMatchObject({ code: 'ETIMEOUT' });
    const owned = (Resolver as unknown as { instances: MockResolver[] }).instances[0];
    expect(owned).toBeDefined();
    expect(owned.cancelled).toBe(true);
  });

  it('cancels the owned resolver on abort', async () => {
    const controller = new AbortController();
    const promise = resolveWithTimeout('hung.test', 'A', 5000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect((Resolver as unknown as { instances: MockResolver[] }).instances[0].cancelled).toBe(
      true,
    );
  });

  it('resolveWithAbort cancels the owned resolver on abort', async () => {
    const controller = new AbortController();
    const promise = resolveWithAbort('hung.test', 'A', controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect((Resolver as unknown as { instances: MockResolver[] }).instances[0].cancelled).toBe(
      true,
    );
  });

  it('never cancels a caller-supplied shared resolver', async () => {
    const shared = new Resolver() as unknown as MockResolverType;
    const controller = new AbortController();
    const promise = resolveWithAbort('hung.test', 'A', controller.signal, shared);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(shared.cancelled).toBe(false);
    // No owned resolver was created for this call.
    expect((Resolver as unknown as { instances: MockResolver[] }).instances).toHaveLength(1);
  });
});
