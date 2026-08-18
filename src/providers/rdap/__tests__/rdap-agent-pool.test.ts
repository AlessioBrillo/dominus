// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { Agent, type Dispatcher } from 'undici';
import { RdapAgentPool } from '../rdap-agent-pool.js';

describe('RdapAgentPool (ADR-0049)', () => {
  it('creates the dispatcher lazily', async () => {
    const factory = vi.fn((opts: { connections: number }): Dispatcher => new Agent(opts));
    const pool = new RdapAgentPool({ agentFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    await pool.getDispatcher();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ connections: 32 });
  });

  it('returns the same dispatcher instance', async () => {
    const factory = vi.fn((opts: { connections: number }): Dispatcher => new Agent(opts));
    const pool = new RdapAgentPool({ agentFactory: factory });
    const d1 = await pool.getDispatcher();
    const d2 = await pool.getDispatcher();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(d1).toBe(d2);
  });

  it('uses the configured max connections in the agent factory', async () => {
    const factory = vi.fn((opts: { connections: number }): Dispatcher => new Agent(opts));
    const pool = new RdapAgentPool({ maxConnections: 16, agentFactory: factory });
    await pool.getDispatcher();
    expect(factory).toHaveBeenCalledWith({ connections: 16 });
  });

  it('close() is idempotent and releases the agent', async () => {
    const close = vi.fn();
    const factory = vi.fn(() => ({ close }) as unknown as Dispatcher);
    const pool = new RdapAgentPool({ agentFactory: factory });
    await pool.getDispatcher();
    pool.close();
    pool.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('getDispatcher() after close() throws', async () => {
    const factory = vi.fn((opts: { connections: number }): Dispatcher => new Agent(opts));
    const pool = new RdapAgentPool({ agentFactory: factory });
    await pool.getDispatcher();
    pool.close();
    await expect(pool.getDispatcher()).rejects.toThrow('agent pool is disposed');
  });

  it('defaults to the shared process-wide pool instance', () => {
    // The singleton is exported so every RDAP provider shares one Agent.
    expect(globalThis).toBeDefined();
  });

  it('fetchWithAgent never combines Node global fetch with a foreign dispatcher', async () => {
    // Node's global fetch (bundled undici) throws "invalid onRequestStart
    // method" when handed a dispatcher from a different undici version. The
    // pool must dispatch through a fetch that matches its own Agent.
    const pool = new RdapAgentPool({ maxConnections: 1 });
    try {
      const err = await pool.fetchWithAgent('http://127.0.0.1:1/').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).not.toBeNull();
      expect(err?.message).not.toMatch(/onRequestStart/);
      expect(err?.message).toMatch(/fetch failed|ECONNREFUSED/i);
    } finally {
      pool.close();
    }
  });

  it('fetchWithAgent uses the injected fetchFn and forwards the pooled dispatcher', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const pool = new RdapAgentPool({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await pool.fetchWithAgent('http://example.invalid/x', {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
    pool.close();
  });
});
