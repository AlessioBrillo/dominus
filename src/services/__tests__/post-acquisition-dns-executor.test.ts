// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { DnsStepExecutor } from '../post-acquisition-dns-executor.js';
import type { DnsWriteGate, DnsWriteGateOptions } from '../dns-write-gate.js';
import { DnsWriteGate as RealGate } from '../dns-write-gate.js';
import type {
  DnsGateVerdict,
  DnsWriteOutcome,
  DnsWriteProvider,
  DnsZoneState,
  PublicDelegationReader,
} from '../../types/dns-write.js';

const managedState: DnsZoneState = {
  domain: 'example.com',
  managed: true,
  records: [],
  expectedNameServers: ['ns1.cloudflare.com'],
};

function fakeProvider(
  options: { available?: boolean; state?: DnsZoneState | null } = {},
): DnsWriteProvider {
  return {
    name: 'fake',
    isAvailable: options.available ?? true,
    readZoneState: vi.fn(async () => options.state ?? null),
    ensureRecords: vi.fn(async (): Promise<DnsWriteOutcome> => ({
      domain: 'example.com',
      applied: true,
      records: [],
      changed: [{ type: 'A', name: '@', content: '5.6.7.8' }],
    })),
  };
}

function fakeReader(
  options: { ns?: string[] | null; addresses?: string[] | null } = {},
): PublicDelegationReader {
  return {
    name: 'fake-reader',
    resolveNameservers: vi.fn(async () => options.ns ?? null),
    resolveAddresses: vi.fn(async () => options.addresses ?? null),
    resolveCanonicalName: vi.fn(async () => null),
  };
}

/** Gate with the evaluate/apply/confirm methods stubbed per scenario. */
function stubGate(partial: {
  evaluate?: () => Promise<DnsGateVerdict>;
  apply?: () => Promise<DnsWriteOutcome>;
  confirm?: () => Promise<boolean>;
}): DnsWriteGate {
  return {
    evaluate: partial.evaluate ?? vi.fn(),
    apply:
      partial.apply ??
      vi.fn(async (): Promise<DnsWriteOutcome> => ({
        domain: 'example.com',
        applied: true,
        records: [],
        changed: [{ type: 'A', name: '@', content: '5.6.7.8' }],
      })),
    confirm: partial.confirm ?? vi.fn(async () => true),
    targetRecords: () => [{ type: 'A' as const, name: '@', content: '5.6.7.8' }],
  } as unknown as DnsWriteGate;
}

const target = { type: 'A' as const, value: '5.6.7.8' };

describe('DnsStepExecutor', () => {
  it('skips in dry-run without touching the gate', async () => {
    const gate = stubGate({});
    const executor = new DnsStepExecutor(gate);

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: true,
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe('dry_run');
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('skips with instructions when the write provider is unavailable', async () => {
    const executor = new DnsStepExecutor(
      new RealGate({ writeProvider: fakeProvider({ available: false }), target }),
    );

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe('dns_write_provider_unavailable');
    expect(outcome.status === 'skipped' && outcome.detail?.instructions).toEqual([
      'Create/update A record for example.com -> 5.6.7.8',
    ]);
  });

  it('fails with the provider error when the state cannot be read', async () => {
    const provider = fakeProvider({ state: managedState });
    provider.readZoneState = vi.fn(async () => {
      throw new Error('cloudflare timeout');
    });
    const executor = new DnsStepExecutor(
      new RealGate({
        writeProvider: provider,
        reader: fakeReader({ ns: ['ns1.cloudflare.com'] }),
        target,
      }),
    );

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toBe('cloudflare timeout');
  });

  it('applies the write and reports done when confirmed', async () => {
    const gate = stubGate({
      evaluate: async () => ({
        action: 'write',
        target: [{ type: 'A', name: '@', content: '5.6.7.8' }],
        expectedNameServers: ['ns1.cloudflare.com'],
      }),
      confirm: vi.fn(async () => true),
    });
    const executor = new DnsStepExecutor(gate);

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('done');
    expect(gate.apply).toHaveBeenCalled();
    expect(gate.confirm).toHaveBeenCalled();
    expect(outcome.status === 'done' && outcome.detail).toEqual({
      changed: 1,
      records: [{ type: 'A', name: '@', content: '5.6.7.8' }],
    });
  });

  it('reports done without a write when already delegated', async () => {
    const gate = stubGate({
      evaluate: async () => ({ action: 'done', reason: 'already_delegated', records: [] }),
    });
    const executor = new DnsStepExecutor(gate);

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('done');
    expect(gate.apply).not.toHaveBeenCalled();
  });

  it('fails with write_unconfirmed when the public side does not confirm', async () => {
    const gate = stubGate({
      evaluate: async () => ({
        action: 'write',
        target: [{ type: 'A', name: '@', content: '5.6.7.8' }],
        expectedNameServers: ['ns1.cloudflare.com'],
      }),
      confirm: async () => false,
    });
    const executor = new DnsStepExecutor(gate);

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toContain('write_unconfirmed');
    expect(outcome.status === 'failed' && outcome.detail).toEqual({ domain: 'example.com' });
  });

  it('end-to-end through the real gate: skips on delegation mismatch with instructions', async () => {
    const executor = new DnsStepExecutor(
      new RealGate({
        writeProvider: fakeProvider({ state: managedState }),
        reader: fakeReader({ ns: ['ns1.other-registrar.net'] }),
        target,
      } satisfies DnsWriteGateOptions),
    );

    const outcome = await executor.execute({
      domain: 'example.com',
      source: 'purchase',
      pipelineRunId: null,
      dryRun: false,
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toBe('delegation_mismatch');
    expect(outcome.status === 'skipped' && outcome.detail?.instructions).toBeDefined();
  });
});
