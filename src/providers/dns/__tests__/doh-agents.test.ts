// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { Agent, type Dispatcher } from 'undici';
import { DohAgentPool } from '../doh-agents.js';

describe('DohAgentPool (ADR-0044)', () => {
  it('returns a stable dispatcher for the same endpoint', () => {
    const pool = new DohAgentPool({ maxConnections: 16 });
    const url = 'https://cloudflare-dns.com/dns-query';
    expect(pool.dispatcherFor(url)).toBe(pool.dispatcherFor(url));
  });

  it('uses a single shared undici Agent for all endpoints', () => {
    const pool = new DohAgentPool({ maxConnections: 16 });
    const a = pool.dispatcherFor('https://cloudflare-dns.com/dns-query');
    const b = pool.dispatcherFor('https://dns.google/dns-query');
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(Agent);
  });

  it('bounds per-origin connections from maxConnections', () => {
    const factory = vi.fn((opts: { connections: number }): Dispatcher => new Agent(opts));
    const pool = new DohAgentPool({ maxConnections: 7, agentFactory: factory });
    pool.dispatcherFor('https://quad9.example/dns-query');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ connections: 7 }));
  });

  it('dispose destroys pooled agents and clears the cache', () => {
    const pool = new DohAgentPool({ maxConnections: 4 });
    const agent = pool.dispatcherFor('https://x.example/dns-query') as Agent;
    const destroySpy = vi.spyOn(agent, 'destroy');
    pool.dispose();
    expect(destroySpy).toHaveBeenCalled();
    expect(pool.dispatcherFor('https://x.example/dns-query')).not.toBe(agent);
  });

  it('is reusable after dispose (lazy re-creation)', () => {
    const pool = new DohAgentPool({ maxConnections: 4 });
    pool.dispose();
    expect(pool.dispatcherFor('https://y.example/dns-query')).toBeDefined();
  });

  it('fetchWithAgent never combines Node global fetch with a foreign dispatcher', async () => {
    // Node's global fetch (bundled undici) throws "invalid onRequestStart
    // method" when handed a dispatcher from a different undici version. The
    // pool must dispatch through a fetch that matches its own Agent.
    const pool = new DohAgentPool({ maxConnections: 1 });
    try {
      const err = await pool.fetchWithAgent('http://127.0.0.1:1/').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).not.toBeNull();
      expect(err?.message).not.toMatch(/onRequestStart/);
      expect(err?.message).toMatch(/fetch failed|ECONNREFUSED/i);
    } finally {
      pool.dispose();
    }
  });

  it('fetchWithAgent uses the injected fetchFn and forwards the shared dispatcher', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const pool = new DohAgentPool({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await pool.fetchWithAgent('http://example.invalid/x', {
      headers: { accept: 'application/dns-json' },
    });
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
    pool.dispose();
  });
});
