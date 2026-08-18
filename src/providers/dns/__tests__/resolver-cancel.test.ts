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

interface MockResolverLike {
  cancelled: boolean;
  resolve: (
    hostname: string,
    rrtype: string,
    callback: (err: Error | null, addresses?: string[]) => void,
  ) => void;
  cancel: () => void;
  setServers: (servers: string[]) => void;
}

const mockState: { instances: MockResolverLike[] } = { instances: [] };

vi.mock('node:dns', () => {
  class MockResolver {
    cancelled = false;
    constructor() {
      mockState.instances.push(this);
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
  return { Resolver: MockResolver };
});

describe('per-call resolver cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.instances = [];
  });

  it('cancels the owned resolver when the timeout fires', async () => {
    const promise = resolveWithTimeout('hung.test', 'A', 50);
    await expect(promise).rejects.toMatchObject({ code: 'ETIMEOUT' });
    const owned = mockState.instances[0]!;
    expect(owned).toBeDefined();
    expect(owned.cancelled).toBe(true);
  });

  it('cancels the owned resolver on abort', async () => {
    const controller = new AbortController();
    const promise = resolveWithTimeout('hung.test', 'A', 5000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockState.instances[0]!.cancelled).toBe(true);
  });

  it('resolveWithAbort cancels the owned resolver on abort', async () => {
    const controller = new AbortController();
    const promise = resolveWithAbort('hung.test', 'A', controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockState.instances[0]!.cancelled).toBe(true);
  });

  it('never cancels a caller-supplied shared resolver', async () => {
    const shared = new Resolver() as unknown as MockResolverLike;
    const controller = new AbortController();
    const promise = resolveWithAbort(
      'hung.test',
      'A',
      controller.signal,
      shared as unknown as Resolver,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(shared.cancelled).toBe(false);
    // No owned resolver was created for this call.
    expect(mockState.instances).toHaveLength(1);
  });
});
