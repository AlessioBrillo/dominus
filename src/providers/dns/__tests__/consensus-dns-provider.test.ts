// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsensusDnsProvider } from '../consensus-dns-provider.js';
import type { ConsensusDnsProviderOptions } from '../consensus-dns-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { DnsCheckResult } from '../../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions } from '../dns-provider.js';
import type { DnsLegSample } from '../index.js';
import type { Mock } from 'vitest';

interface MockDnsProvider extends DnsProvider {
  checkAvailability: Mock;
  checkBulk: Mock;
  clearCache: Mock;
  pruneCache: Mock;
  dispose: Mock;
}

function makeResult(domain: string, status: DomainStatus): DnsCheckResult {
  return { domain, status, checkedAt: new Date().toISOString() };
}

function createMockProvider(
  name: string,
  behavior: 'available' | 'registered' | 'unknown' | 'error' | 'custom',
  customResult?: DnsCheckResult,
): MockDnsProvider {
  const checkAvailabilityFn = vi.fn(
    async (
      domain: string,
      _signal?: AbortSignal,
      _options?: DnsCheckOptions,
    ): Promise<DnsCheckResult> => {
      if (behavior === 'custom' && customResult) {
        return { ...customResult, domain };
      }
      switch (behavior) {
        case 'available':
          return makeResult(domain, DomainStatus.Available);
        case 'registered':
          return makeResult(domain, DomainStatus.Registered);
        case 'unknown':
          return makeResult(domain, DomainStatus.Unknown);
        case 'error':
          throw new Error('Provider error');
        default:
          return makeResult(domain, DomainStatus.Unknown);
      }
    },
  );

  const checkBulkFn = vi.fn(
    async (
      domains: string[],
      _signal?: AbortSignal,
      _options?: DnsCheckOptions,
    ): Promise<DnsCheckResult[]> => {
      return domains.map((d) => {
        if (behavior === 'custom' && customResult) {
          return { ...customResult, domain: d };
        }
        switch (behavior) {
          case 'available':
            return makeResult(d, DomainStatus.Available);
          case 'registered':
            return makeResult(d, DomainStatus.Registered);
          case 'unknown':
            return makeResult(d, DomainStatus.Unknown);
          case 'error':
            throw new Error('Provider error');
          default:
            return makeResult(d, DomainStatus.Unknown);
        }
      });
    },
  );

  return {
    name,
    checkAvailability: checkAvailabilityFn,
    checkBulk: checkBulkFn,
    clearCache: vi.fn(),
    pruneCache: vi.fn(() => 0),
    dispose: vi.fn(),
  };
}

function createDisjointnessValidator(): { isDisjoint: Mock } {
  return { isDisjoint: vi.fn(() => true) };
}

describe('ConsensusDnsProvider', () => {
  let telemetryCalls: DnsLegSample[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    telemetryCalls = [];
  });

  afterEach(() => {
    // vi.useRealTimers(); // Already using real timers
  });

  function createProvider(
    primary: MockDnsProvider,
    secondary: MockDnsProvider,
    tertiary: MockDnsProvider | undefined,
    options?: { requiredConfirmations?: 1 | 2; degradedRatio?: number; degradedMin?: number },
  ): ConsensusDnsProvider {
    const opts: ConsensusDnsProviderOptions = {
      primary,
      secondary,
      disjointnessValidator: createDisjointnessValidator(),
      breakers: undefined,
      telemetry: (sample: DnsLegSample) => telemetryCalls.push(sample),
      config: {
        requiredConfirmations: options?.requiredConfirmations ?? 1,
        degradedRatio: options?.degradedRatio ?? 0.5,
        degradedMin: options?.degradedMin ?? 10,
      },
    };
    if (tertiary !== undefined) {
      opts.tertiary = tertiary;
    }
    return new ConsensusDnsProvider(opts);
  }

  describe('2-of-3 consensus (requiredConfirmations=1)', () => {
    it('returns Available when primary=Available, secondary=Available', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Available);
    });

    it('returns Unknown when primary=Available, secondary=Registered (veto)', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'registered');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('returns Unknown when primary=Available, secondary=Unknown (no tertiary)', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'unknown');
      const provider = createProvider(primary, secondary, undefined);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('returns Unknown when primary=Available, secondary=Error (no tertiary)', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'error');
      const provider = createProvider(primary, secondary, undefined);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('returns Registered when primary=Registered (no consensus needed)', async () => {
      const primary = createMockProvider('Primary', 'registered');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Registered);
    });

    it('returns Unknown when primary=Unknown (no consensus on Unknown)', async () => {
      const primary = createMockProvider('Primary', 'unknown');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });
  });

  describe('2-of-2+1 tertiary rescue (requiredConfirmations=1, tertiaryEnabled=true)', () => {
    it('rescues with tertiary when secondary fails but tertiary=Available', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'error');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Available);
    });

    it('vetoes with tertiary=Registered when secondary fails', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'error');
      const tertiary = createMockProvider('Tertiary', 'registered');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('returns Unknown when both secondary and tertiary fail', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'error');
      const tertiary = createMockProvider('Tertiary', 'error');
      const provider = createProvider(primary, secondary, tertiary);
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('does not query tertiary when secondary confirms Available', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      await provider.checkAvailability('test.com');
      expect(tertiary.checkAvailability).not.toHaveBeenCalled();
    });

    it('queries tertiary when secondary returns Unknown', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'unknown');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      await provider.checkAvailability('test.com');
      expect(tertiary.checkAvailability).toHaveBeenCalled();
    });
  });

  describe('BothRequired mode (requiredConfirmations=2)', () => {
    it('requires both secondary AND tertiary to confirm Available', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary, { requiredConfirmations: 2 });
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Available);
      expect(secondary.checkAvailability).toHaveBeenCalled();
      expect(tertiary.checkAvailability).toHaveBeenCalled();
    });

    it('returns Unknown when secondary=Available but tertiary=Unknown', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'unknown');
      const provider = createProvider(primary, secondary, tertiary, { requiredConfirmations: 2 });
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('returns Unknown when secondary=Available but tertiary=Registered (veto)', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'registered');
      const provider = createProvider(primary, secondary, tertiary, { requiredConfirmations: 2 });
      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });

    it('does not query tertiary when secondary=Registered (veto)', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'registered');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary, { requiredConfirmations: 2 });
      await provider.checkAvailability('test.com');
      expect(tertiary.checkAvailability).not.toHaveBeenCalled();
    });
  });

  describe('Bulk operations', () => {
    it('processes multiple domains in checkBulk', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const results = await provider.checkBulk(['a.com', 'b.com', 'c.com']);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === DomainStatus.Available)).toBe(true);
    });

    it('applies consensus per-domain in bulk', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'registered');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      const results = await provider.checkBulk(['a.com', 'b.com']);
      expect(results.every((r) => r.status === DomainStatus.Unknown)).toBe(true);
    });
  });

  describe('Telemetry emission', () => {
    it('emits telemetry for primary leg', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      await provider.checkAvailability('test.com');
      const primaryTelemetry = telemetryCalls.find((t) => t.role === 'primary');
      expect(primaryTelemetry).toBeDefined();
      expect(primaryTelemetry?.verdict).toBe('available');
    });

    it('emits telemetry for secondary leg when queried', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      await provider.checkAvailability('test.com');
      const secondaryTelemetry = telemetryCalls.find((t) => t.role === 'consensus');
      expect(secondaryTelemetry).toBeDefined();
    });

    it('emits telemetry for tertiary leg when queried', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'error');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      await provider.checkAvailability('test.com');
      const tertiaryTelemetry = telemetryCalls.find((t) => t.role === 'tertiary');
      expect(tertiaryTelemetry).toBeDefined();
    });
  });

  describe('Cache management', () => {
    it('clearCache delegates to all providers', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      provider.clearCache();
      expect(primary.clearCache).toHaveBeenCalled();
      expect(secondary.clearCache).toHaveBeenCalled();
      expect(tertiary.clearCache).toHaveBeenCalled();
    });

    it('pruneCache delegates to all providers and sums results', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      primary.pruneCache.mockReturnValue(5);
      secondary.pruneCache.mockReturnValue(3);
      tertiary.pruneCache.mockReturnValue(2);
      const provider = createProvider(primary, secondary, tertiary);
      const result = provider.pruneCache();
      expect(result).toBe(10);
    });

    it('dispose delegates to all providers', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const provider = createProvider(primary, secondary, tertiary);
      provider.dispose?.();
      expect(primary.dispose).toHaveBeenCalled();
      expect(secondary.dispose).toHaveBeenCalled();
      expect(tertiary.dispose).toHaveBeenCalled();
    });
  });

  describe('Disjointness check failure', () => {
    it('returns Unknown when disjointness check fails', async () => {
      const primary = createMockProvider('Primary', 'available');
      const secondary = createMockProvider('Secondary', 'available');
      const tertiary = createMockProvider('Tertiary', 'available');
      const disjointnessValidator = { isDisjoint: vi.fn(() => false) };

      // Provide endpoints for the disjointness check to run
      const primaryEndpoints = {
        flatEndpoints: ['doh:cloudflare-dns.com'],
        endpointDetails: [
          {
            identity: 'doh:cloudflare-dns.com',
            ips: new Set(['1.1.1.1']),
            hostname: 'cloudflare-dns.com',
          },
        ],
        operators: new Map([['doh:cloudflare-dns.com', 'cloudflare']]),
        transports: new Map([['doh:cloudflare-dns.com', 'doh']]),
      };
      const secondaryEndpoints = {
        flatEndpoints: ['dot:1.1.1.1'],
        endpointDetails: [
          { identity: 'dot:1.1.1.1', ips: new Set(['1.1.1.1']), hostname: '1.1.1.1' },
        ],
        operators: new Map([['dot:1.1.1.1', 'cloudflare']]),
        transports: new Map([['dot:1.1.1.1', 'dot']]),
      };

      const opts: ConsensusDnsProviderOptions = {
        primary,
        secondary,
        tertiary,
        disjointnessValidator,
        breakers: undefined,
        telemetry: (sample: DnsLegSample) => telemetryCalls.push(sample),
        config: { requiredConfirmations: 1, degradedRatio: 0.5, degradedMin: 10 },
        primaryEndpoints,
        secondaryEndpoints,
      };
      const provider = new ConsensusDnsProvider(opts);

      const result = await provider.checkAvailability('test.com');
      expect(result.status).toBe(DomainStatus.Unknown);
    });
  });
});
