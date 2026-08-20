// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeDnsProvider } from '../node-dns-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { buildDnsConsensusConfig } from '../../../app/provider-factory.js';
import { loadConfig, resetConfig } from '../../../config.js';

const mockSetServersCalls = vi.hoisted(() => [] as string[][]);

vi.mock('node:dns', () => {
  class MockResolver {
    resolve(
      _domain: string,
      _rrtype: string,
      callback: (err: Error | null, addresses?: string[]) => void,
    ): void {
      callback(null, ['1.2.3.4']);
    }
    cancel(): void {}
    setServers(servers: string[]): void {
      mockSetServersCalls.push(servers);
    }
  }
  return { promises: { resolve: vi.fn().mockResolvedValue([]) }, Resolver: MockResolver };
});

const COMPOSE_PATH = fileURLToPath(
  new URL('../../../../docker-compose.dns-consensus.yml', import.meta.url),
);
const UNBOUND_CONF_PATH = fileURLToPath(
  new URL('../../../../deploy/unbound/unbound.conf', import.meta.url),
);

const APP_SERVICES = ['api', 'worker', 'scheduler'];

function composeServiceBlock(service: string): string {
  const lines = readFileSync(COMPOSE_PATH, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${service}:`);
  expect(start, `compose override must define service '${service}'`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || (line.length > 0 && line[0] !== ' ')) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('DNS consensus wiring (native leg pin + rigorous DNSSEC)', () => {
  beforeEach(() => {
    mockSetServersCalls.length = 0;
  });

  describe('docker-compose.dns-consensus.yml', () => {
    it.each(APP_SERVICES)(
      "pins the native leg to the recursor on '%s' via DNS_NAMESERVERS",
      (service) => {
        const block = composeServiceBlock(service);
        expect(block).toContain('- DNS_NAMESERVERS=172.20.0.10:5300');
      },
    );

    it.each(APP_SERVICES)(
      "keeps the consensus gate enabled on '%s' (2-of-3 secondary leg)",
      (service) => {
        const block = composeServiceBlock(service);
        expect(block).toContain('- DNS_CONSENSUS_ENABLED=true');
        expect(block).toContain('- DNS_CONSENSUS_NAMESERVERS=172.20.0.10:5300');
      },
    );

    it.each(APP_SERVICES)(
      "enables the doh-alternate tertiary on '%s' (ADR-0064, no consensus SPOF)",
      (service) => {
        const block = composeServiceBlock(service);
        expect(block).toContain('- DNS_TERTIARY_ENABLED=true');
        expect(block).toContain('- DNS_TERTIARY_STRATEGY=doh-alternate');
      },
    );

    it.each(APP_SERVICES)("attaches '%s' to the recursor network", (service) => {
      const block = composeServiceBlock(service);
      expect(block).toContain('- dns-consensus-net');
    });

    it('boots the 2-of-3 gate from the override env (gate actually built)', async () => {
      // The compose-config CI job asserts the env statically, but the gate
      // is vetoed at RUNTIME when the consensus resolver set overlaps the
      // primary's — and the pinned native fallback used to collide with the
      // consensus pin, silently disabling consensus in the turnkey topology.
      // Boot-equivalent regression: feed the override env through the real
      // config loader and assert the gate is actually constructed.
      const keys = [
        'DNS_NAMESERVERS',
        'DNS_CONSENSUS_ENABLED',
        'DNS_CONSENSUS_NAMESERVERS',
      ] as const;
      const saved = keys.map((k) => [k, process.env[k]] as const);
      try {
        for (const k of keys) delete process.env[k];
        process.env.DNS_NAMESERVERS = '172.20.0.10:5300';
        process.env.DNS_CONSENSUS_ENABLED = 'true';
        process.env.DNS_CONSENSUS_NAMESERVERS = '172.20.0.10:5300';
        resetConfig();
        const config = loadConfig();
        const consensus = await buildDnsConsensusConfig(config);
        expect(consensus).toBeDefined();
        expect(typeof consensus?.secondaryProvider.checkAvailability).toBe('function');
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        resetConfig();
      }
    });

    it('boots the doh-alternate tertiary from the override env (gate actually built)', async () => {
      // ADR-0064: the override turns the tertiary on, and the tertiary leg
      // must survive the disjointness check against BOTH the primary (DoH)
      // and the pinned secondary (Unbound) — OpenDNS is operator-disjoint
      // from both. Boot-equivalent regression: the leg is vetoed at runtime
      // on any overlap, so assert the 2-of-3 gate still constructs with a
      // tertiary provider attached.
      const keys = [
        'DNS_NAMESERVERS',
        'DNS_CONSENSUS_ENABLED',
        'DNS_CONSENSUS_NAMESERVERS',
        'DNS_TERTIARY_ENABLED',
        'DNS_TERTIARY_STRATEGY',
      ] as const;
      const saved = keys.map((k) => [k, process.env[k]] as const);
      try {
        for (const k of keys) delete process.env[k];
        process.env.DNS_NAMESERVERS = '172.20.0.10:5300';
        process.env.DNS_CONSENSUS_ENABLED = 'true';
        process.env.DNS_CONSENSUS_NAMESERVERS = '172.20.0.10:5300';
        process.env.DNS_TERTIARY_ENABLED = 'true';
        process.env.DNS_TERTIARY_STRATEGY = 'doh-alternate';
        resetConfig();
        const config = loadConfig();
        const consensus = await buildDnsConsensusConfig(config);
        expect(consensus).toBeDefined();
        expect(typeof consensus?.tertiaryProvider?.checkAvailability).toBe('function');
        expect(consensus?.requiredAvailable).toBe(config.DNS_CONSENSUS_REQUIRED_AVAILABLE);
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        resetConfig();
      }
    });
  });

  describe('deploy/unbound/unbound.conf', () => {
    const conf = readFileSync(UNBOUND_CONF_PATH, 'utf8');

    it('validates DNSSEC from the RFC 5011 trust anchor', () => {
      expect(conf).toContain('auto-trust-anchor-file: "/opt/unbound/etc/unbound/var/root.key"');
    });

    it('is fail-closed on bogus answers (SERVFAIL, never permissive)', () => {
      expect(conf).toContain('val-permissive-mode: no');
      expect(conf).toContain('val-clean-additional: yes');
    });

    it('hardens denial of existence with aggressive NSEC', () => {
      expect(conf).toContain('aggressive-nsec: yes');
      expect(conf).toContain('harden-below-nxdomain: yes');
      expect(conf).toContain('harden-dnssec-stripped: yes');
    });

    it('hardens the referral path and algorithm downgrade', () => {
      expect(conf).toContain('harden-referral-path: yes');
      expect(conf).toContain('harden-algo-downgrade: yes');
      expect(conf).toContain('deny-any: yes');
    });
  });

  describe('native leg resolver', () => {
    it('forwards host:port nameservers verbatim to the dedicated resolver', async () => {
      const provider = new NodeDnsProvider({
        cacheTtlMs: 60_000,
        lookupStrategy: 'native',
        nameservers: ['172.20.0.10:5300'],
      });
      const result = await provider.checkAvailability('example.com');
      expect(result.status).toBe(DomainStatus.Registered);
      expect(mockSetServersCalls).toEqual([['172.20.0.10:5300']]);
    });

    it('caches one resolver per nameserver set (port included in the cache key)', async () => {
      const provider = new NodeDnsProvider({
        cacheTtlMs: 60_000,
        lookupStrategy: 'native',
        nameservers: ['172.20.0.10:5300'],
      });
      await provider.checkAvailability('one.com');
      await provider.checkAvailability('two.com');
      expect(mockSetServersCalls).toEqual([['172.20.0.10:5300']]);
    });
  });
});
