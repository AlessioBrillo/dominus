// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { DnsWriteGate, formatDelegationInstructions } from '../dns-write-gate.js';
import type {
  DnsRecord,
  DnsWriteProvider,
  DnsWriteOutcome,
  DnsZoneState,
  PublicDelegationReader,
} from '../../types/dns-write.js';

function fakeWriteProvider(options: {
  available?: boolean;
  state?: DnsZoneState | null;
  ensure?: DnsWriteOutcome;
}): DnsWriteProvider {
  return {
    name: 'fake',
    isAvailable: options.available ?? true,
    readZoneState: vi.fn(async () => options.state ?? null),
    ensureRecords: vi.fn(
      async (): Promise<DnsWriteOutcome> =>
        options.ensure ?? {
          domain: 'example.com',
          applied: true,
          records: [],
          changed: [],
        },
    ),
  };
}

function fakeReader(options: {
  ns?: string[] | null;
  addresses?: string[] | null;
  cname?: string | null;
}): PublicDelegationReader {
  return {
    name: 'fake-reader',
    resolveNameservers: vi.fn(async () => options.ns ?? null),
    resolveAddresses: vi.fn(async () => options.addresses ?? null),
    resolveCanonicalName: vi.fn(async () => options.cname ?? null),
  };
}

const managedState: DnsZoneState = {
  domain: 'example.com',
  managed: true,
  records: [],
  expectedNameServers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
};

const target = { type: 'A' as const, value: '5.6.7.8' };

describe('DnsWriteGate', () => {
  it('skips when the write provider is unavailable', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ available: false }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({ action: 'skip', reason: 'dns_write_provider_unavailable' });
  });

  it('skips when no delegation target is configured', async () => {
    const gate = new DnsWriteGate({ writeProvider: fakeWriteProvider({ state: managedState }) });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({ action: 'skip', reason: 'target_not_configured' });
  });

  it('skips when the zone is not managed by the write provider', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: null }),
      reader: fakeReader({ ns: ['ns1.cloudflare.com'] }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({ action: 'skip', reason: 'zone_not_managed' });
  });

  it('skips when no independent reader is available (fail-closed)', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({ action: 'skip', reason: 'delegation_unverifiable' });
  });

  it('skips when public DNS cannot answer the delegation (fail-closed)', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({ ns: null }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict.action).toBe('skip');
    expect(verdict.action === 'skip' && verdict.reason).toBe('delegation_unverifiable');
  });

  it('skips with delegation_mismatch when the public NS differ from the zone', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({ ns: ['ns1.example-registrar.net', 'ns2.example-registrar.net'] }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict.action).toBe('skip');
    expect(verdict.action === 'skip' && verdict.reason).toBe('delegation_mismatch');
    expect(verdict.action === 'skip' && verdict.detail).toEqual({
      domain: 'example.com',
      publicNameServers: ['ns1.example-registrar.net', 'ns2.example-registrar.net'],
      expectedNameServers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    });
  });

  it('reports done when the domain already resolves to the target', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({
        ns: ['ns2.cloudflare.com', 'ns1.cloudflare.com'],
        addresses: ['5.6.7.8'],
      }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({ action: 'done', reason: 'already_delegated', records: [] });
  });

  it('requires a write when the delegation is corroborated but not live', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({
        ns: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
        addresses: ['9.9.9.9'],
      }),
      target,
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict).toEqual({
      action: 'write',
      target: [{ type: 'A', name: '@', content: '5.6.7.8' }],
      expectedNameServers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    });
  });

  it('matches a CNAME target case-insensitively', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({
        ns: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
        cname: 'Park.Sedo.com.',
      }),
      target: { type: 'CNAME', value: 'park.sedo.com' },
    });
    const verdict = await gate.evaluate('example.com');
    expect(verdict.action).toBe('done');
  });

  it('propagates provider read failures as thrown errors', async () => {
    const provider = fakeWriteProvider({ state: managedState });
    provider.readZoneState = vi.fn(async () => {
      throw new Error('cloudflare unreachable');
    });
    const gate = new DnsWriteGate({
      writeProvider: provider,
      reader: fakeReader({ ns: ['ns1.cloudflare.com'] }),
      target,
    });
    await expect(gate.evaluate('example.com')).rejects.toThrow('cloudflare unreachable');
  });

  it('apply delegates to the provider with the target records', async () => {
    const writeProvider = fakeWriteProvider({ state: managedState });
    const gate = new DnsWriteGate({ writeProvider, reader: fakeReader({ ns: [] }), target });
    await gate.apply('example.com');
    expect(writeProvider.ensureRecords).toHaveBeenCalledWith('example.com', [
      { type: 'A', name: '@', content: '5.6.7.8' },
    ]);
  });

  it('confirm reports the public view after the write', async () => {
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader: fakeReader({ ns: ['ns1.cloudflare.com'], addresses: ['5.6.7.8'] }),
      target,
    });
    expect(await gate.confirm('example.com')).toBe(true);
  });

  it('confirm retries while the resolver is still catching up', async () => {
    const reader = fakeReader({ ns: ['ns1.cloudflare.com'], addresses: ['9.9.9.9'] });
    let calls = 0;
    reader.resolveAddresses = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? ['9.9.9.9'] : ['5.6.7.8'];
    });
    const sleeps: number[] = [];
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader,
      target,
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    expect(await gate.confirm('example.com')).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('confirm gives up after the bounded attempts', async () => {
    const reader = fakeReader({ ns: ['ns1.cloudflare.com'], addresses: ['9.9.9.9'] });
    const sleeps: number[] = [];
    const gate = new DnsWriteGate({
      writeProvider: fakeWriteProvider({ state: managedState }),
      reader,
      target,
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    expect(await gate.confirm('example.com')).toBe(false);
    expect(sleeps).toEqual([2000, 4000]);
  });
});

describe('formatDelegationInstructions', () => {
  it('renders one human-readable instruction per record', () => {
    const records: DnsRecord[] = [
      { type: 'A', name: '@', content: '5.6.7.8' },
      { type: 'CNAME', name: 'www', content: 'park.sedo.com' },
    ];
    const instructions = formatDelegationInstructions('example.com', records);
    expect(instructions).toEqual([
      'Create/update A record for example.com -> 5.6.7.8',
      'Create/update CNAME record for www.example.com -> park.sedo.com',
    ]);
  });
});
