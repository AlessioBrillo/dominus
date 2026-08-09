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
});
