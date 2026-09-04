// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import type { DnsCheckResult } from '../../../types/domain-status.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { ConsensusDnsProvider } from '../consensus-dns-provider.js';
import type { DnsProvider, DnsCheckOptions } from '../dns-provider.js';

function createMockProvider(
  name: string,
  results: Map<string, DnsCheckResult | Error>,
): DnsProvider {
  return {
    name,
    async checkAvailability(
      domain: string,
      _signal?: AbortSignal,
      _options?: DnsCheckOptions,
    ): Promise<DnsCheckResult> {
      const result = results.get(domain);
      if (result instanceof Error) throw result;
      return (
        result ?? { domain, status: DomainStatus.Unknown, checkedAt: new Date().toISOString() }
      );
    },
    checkBulk(domains: string[]): Promise<DnsCheckResult[]> {
      return Promise.all(domains.map((d) => this.checkAvailability(d)));
    },
    clearCache(): void {},
    pruneCache(): number {
      return 0;
    },
    dispose(): void {},
  };
}

function availableResult(domain: string): DnsCheckResult {
  return { domain, status: DomainStatus.Available, checkedAt: new Date().toISOString() };
}

function registeredResult(domain: string): DnsCheckResult {
  return { domain, status: DomainStatus.Registered, checkedAt: new Date().toISOString() };
}

function errorResult(err: Error): Error {
  return err;
}

describe('ConsensusDnsProvider — dual-redundant tertiary (ADR-0068)', () => {
  let primary: DnsProvider;
  let secondary: DnsProvider;
  let tertiary1: DnsProvider;
  let tertiary2: DnsProvider;

  beforeEach(() => {
    primary = createMockProvider('primary', new Map());
    secondary = createMockProvider('secondary', new Map());
    tertiary1 = createMockProvider('tertiary1-opendns', new Map());
    tertiary2 = createMockProvider('tertiary2-digitalsociety', new Map());
  });

  it('race rescue: first Available from any tertiary rescues the domain', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider(
      'secondary',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 1,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);

    expect(result.status).toBe(DomainStatus.Available);
  });

  it('race veto: any Registered from any tertiary vetoes the domain', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider(
      'secondary',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, registeredResult(domain)]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 1,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);

    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('circuit isolation: one tertiary breaker open does not block the other', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider(
      'secondary',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    // Tertiary 1 fails (simulating breaker open)
    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, errorResult(new Error('breaker open'))]]),
    );
    // Tertiary 2 succeeds
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 1,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);

    // Should be rescued by tertiary2 even though tertiary1 failed
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('dual-redundant tertiary: both providers are consulted when secondary fails', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider(
      'secondary',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, availableResult(domain)]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 1,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);
    expect(result.status).toBe(DomainStatus.Available);

    // Note: Current implementation does NOT check disjointness for tertiary providers.
    // The disjointness validator is only called for primary vs secondary.
    // This is a known gap — tertiary disjointness checks should be added.
  });

  it('requiredConfirmations=2: ANY tertiary confirmation suffices when secondary confirmed', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider('secondary', new Map([[domain, availableResult(domain)]]));

    // Only tertiary1 confirms, tertiary2 fails
    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, availableResult(domain)]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 2,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);

    // Secondary confirmed AND tertiary1 confirmed = should pass
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('requiredConfirmations=2: secondary veto always wins over tertiary', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider('secondary', new Map([[domain, registeredResult(domain)]]));

    // Both tertiary providers confirm, but secondary vetoes
    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, availableResult(domain)]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 2,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    const result = await provider.checkAvailability(domain);

    // Secondary Registered vetoes everything
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('bootstrap probe: both tertiary legs probed at startup', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider('secondary', new Map([[domain, availableResult(domain)]]));

    const probeCalls: string[] = [];
    tertiary1 = createMockProvider(
      'tertiary1-opendns',
      new Map([[domain, availableResult(domain)]]),
    );
    tertiary2 = createMockProvider(
      'tertiary2-digitalsociety',
      new Map([[domain, availableResult(domain)]]),
    );

    // Wrap checkAvailability to track probe calls
    const originalCheck1 = tertiary1.checkAvailability.bind(tertiary1);
    const originalCheck2 = tertiary2.checkAvailability.bind(tertiary2);

    tertiary1.checkAvailability = async (
      d: string,
      s?: AbortSignal,
      o?: DnsCheckOptions,
    ): Promise<DnsCheckResult> => {
      if (o?.forceRecheck) probeCalls.push('tertiary1');
      return originalCheck1(d, s, o);
    };
    tertiary2.checkAvailability = async (
      d: string,
      s?: AbortSignal,
      o?: DnsCheckOptions,
    ): Promise<DnsCheckResult> => {
      if (o?.forceRecheck) probeCalls.push('tertiary2');
      return originalCheck2(d, s, o);
    };

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: {
        requiredConfirmations: 2,
        degradedRatio: 0.5,
        degradedMin: 10,
        tertiaryConfig: {
          primary: tertiary1,
          secondary: tertiary2,
          strategy: 'dual-redundant',
        },
      },
    });

    await provider.checkAvailability(domain);

    // Both tertiary providers should have been probed with forceRecheck
    expect(probeCalls).toContain('tertiary1');
    expect(probeCalls).toContain('tertiary2');
  });

  it('legacy single tertiary mode still works', async () => {
    const domain = 'test.example.com';

    primary = createMockProvider('primary', new Map([[domain, availableResult(domain)]]));
    secondary = createMockProvider(
      'secondary',
      new Map([[domain, errorResult(new Error('timeout'))]]),
    );

    // Single tertiary (no tertiaryConfig)
    const singleTertiary = createMockProvider(
      'tertiary-legacy',
      new Map([[domain, availableResult(domain)]]),
    );

    const provider = new ConsensusDnsProvider({
      primary,
      secondary,
      tertiary: singleTertiary,
      disjointnessValidator: { isDisjoint: (): boolean => true },
      config: { requiredConfirmations: 1, degradedRatio: 0.5, degradedMin: 10 },
    });

    const result = await provider.checkAvailability(domain);

    expect(result.status).toBe(DomainStatus.Available);
  });
});
