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
});
