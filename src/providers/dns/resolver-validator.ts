// SPDX-License-Identifier: AGPL-3.0-only
import { promises as dnsPromises } from 'node:dns';
import type { DnsResolverGroup, CollectResolverEndpointsOptions } from './dns-provider.js';
import { collectResolverEndpoints } from './dns-provider.js';
import type { DnsProvider } from './dns-provider.js';
import { getLogger } from '../../logger.js';

const PROBE_DOMAINS = ['google.com', 'cloudflare.com', 'github.com'];

const VALIDATION_TIMEOUT_MS = 5000;

/** Per-hostname DoH resolution budget for the boot-time independence check. */
const HOST_RESOLUTION_TIMEOUT_MS = 2000;

/**
 * Known resolver operators, keyed by the endpoint keys produced by
 * collectResolverEndpoints() plus resolved DoH IPs. Two legs from the same
 * operator are NOT independent opinions even over different transports:
 * a correlated incident (BGP hijack, anycast outage, IXP fault) takes both
 * down together. The map covers the well-known public resolvers; unknown
 * hosts carry no operator and are judged on endpoint/IP overlap alone.
 */
const OPERATOR_HINTS: Readonly<Record<string, string>> = {
  'doh:cloudflare-dns.com': 'cloudflare',
  'doh:one.one.one.one': 'cloudflare',
  'doh:dns.google': 'google',
  'doh:dns.google.com': 'google',
  'doh:dns.quad9.net': 'quad9',
  'doh:dns.adguard.com': 'adguard',
  'doh:dns.mullvad.net': 'mullvad',
  'ip:1.1.1.1': 'cloudflare',
  'ip:1.0.0.1': 'cloudflare',
  'ip:162.159.36.1': 'cloudflare',
  'ip:162.159.46.1': 'cloudflare',
  'ip:8.8.8.8': 'google',
  'ip:8.8.4.4': 'google',
  'ip:9.9.9.9': 'quad9',
  'ip:149.112.112.112': 'quad9',
  'ip:94.140.14.14': 'adguard',
  'ip:94.140.15.15': 'adguard',
  'ip:194.242.2.2': 'mullvad',
  'ip:193.138.218.74': 'mullvad',
  'ip:45.90.28.2': 'nextdns',
  'ip:45.90.30.2': 'nextdns',
};

export interface ConsensusDisjointnessReport {
  /** False when the two resolver sets are not independent opinions. */
  ok: boolean;
  /** Shared endpoint keys (host-level and resolved-IP level). */
  overlapEndpoints: string[];
  /** Resolver operators present on BOTH sides (same org over two transports). */
  overlapOperators: string[];
  /**
   * True when at least one DoH hostname could not be resolved at boot. The
   * check then ran on the hostname-level keys and operator hints alone —
   * resolved-IP overlap for that host could not be proven.
   */
  resolutionPartial: boolean;
}

/**
 * DoH hostnames of the groups that must be resolved to IPs. The string
 * endpoint keys of two strategies can pass the hostname-level check while
 * the same operator (or even the same anycast IP) serves both legs over
 * different transports — `doh:cloudflare-dns.com` vs `dot:1.1.1.1` is the
 * same company twice, but no string comparison can see it.
 */
function collectDohHosts(
  groups: DnsResolverGroup[],
  options?: CollectResolverEndpointsOptions,
): string[] {
  const hosts = new Set<string>();
  for (const group of groups) {
    if (options?.excludeFallbacks && group.fallback === true) continue;
    for (const lookup of group.lookups) {
      if (lookup.type !== 'doh') continue;
      try {
        const host = new URL(lookup.endpoint ?? '').hostname;
        if (host !== '') hosts.add(host);
      } catch {
        // Malformed endpoint — collectResolverEndpoints already ignores it.
      }
    }
  }
  return [...hosts];
}

function resolveHostWithTimeout(
  host: string,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<string[]> {
  return Promise.race([
    resolveHost(host),
    new Promise<string[]>((resolve) => {
      setTimeout(() => resolve([]), HOST_RESOLUTION_TIMEOUT_MS).unref();
    }),
  ]);
}

/**
 * Resolve a hostname to A + AAAA addresses via node:dns with a short
 * budget. Returns [] on any failure — the operator hints on the hostname
 * still apply, and the caller records the partial resolution in the
 * report instead of failing the whole independence check over a boot-time
 * transient (disabling the gate because a resolution was slow would be
 * the P0 failure this module exists to prevent).
 */
export async function resolveHostAddresses(
  host: string,
  resolveHost?: (host: string) => Promise<string[]>,
): Promise<string[]> {
  if (resolveHost !== undefined) return resolveHost(host);
  return resolveHostWithTimeout(host, async (h) => {
    const [v4, v6] = await Promise.all([
      dnsPromises.resolve(h, 'A').catch(() => [] as string[]),
      dnsPromises.resolve(h, 'AAAA').catch(() => [] as string[]),
    ]);
    return [...v4, ...v6];
  });
}

/**
 * Full independence check for the 2-of-3 consensus gate. Combines:
 *
 * 1. Hostname-level endpoint disjointness (the legacy sync check);
 * 2. Resolved-IP disjointness: DoH hostnames are resolved and every
 *    address compared across transports (`ip:` keys), catching
 *    `doh:cloudflare-dns.com` vs `dot:1.1.1.1` — the same anycast IP
 *    behind two transports;
 * 3. Operator disjointness: if the same known resolver operator appears
 *    on both sides (Cloudflare behind DoH and DoT), the opinions are not
 *    independent regardless of the IPs involved.
 *
 * Fail-open on resolution errors (logged via `resolutionPartial`): the
 * gate must not be disabled by a transient boot-time resolution failure.
 */
export async function validateConsensusDisjointness(
  primaryGroups: DnsResolverGroup[],
  primaryNameservers: string[] | undefined,
  consensusGroups: DnsResolverGroup[],
  consensusNameservers: string[] | undefined,
  options?: {
    excludeFallbacks?: boolean;
    resolveHost?: (host: string) => Promise<string[]>;
  },
): Promise<ConsensusDisjointnessReport> {
  const collectOpts = options?.excludeFallbacks ? { excludeFallbacks: true } : undefined;
  const primaryBase = collectResolverEndpoints(primaryGroups, primaryNameservers, collectOpts);
  const consensusBase = collectResolverEndpoints(
    consensusGroups,
    consensusNameservers,
    collectOpts,
  );

  const primaryDohHosts = collectDohHosts(primaryGroups, collectOpts);
  const consensusDohHosts = collectDohHosts(consensusGroups, collectOpts);

  const primary = new Set(primaryBase);
  const consensus = new Set(consensusBase);
  let resolutionPartial = false;

  const resolved = new Map<string, string[]>();
  const resolveFor = async (host: string): Promise<string[]> => {
    let ips = resolved.get(host);
    if (ips === undefined) {
      ips = await resolveHostAddresses(host, options?.resolveHost);
      resolved.set(host, ips);
    }
    return ips;
  };

  for (const host of primaryDohHosts) {
    const ips = await resolveFor(host);
    // Empty means the boot-time resolution failed (or the host genuinely has
    // no addresses — the same outcome for this check). The operator hints
    // on the hostname still apply; record the partial resolution so the
    // caller can log that resolved-IP overlap could not be proven.
    if (ips.length === 0) resolutionPartial = true;
    for (const ip of ips) primary.add(`ip:${ip}`);
  }
  for (const host of consensusDohHosts) {
    const ips = await resolveFor(host);
    if (ips.length === 0) resolutionPartial = true;
    for (const ip of ips) consensus.add(`ip:${ip}`);
  }

  const overlapEndpoints = [...consensus].filter((e) => primary.has(e));

  const operatorsOf = (set: Set<string>): Set<string> => {
    const ops = new Set<string>();
    for (const key of set) {
      const op = OPERATOR_HINTS[key];
      if (op !== undefined) ops.add(op);
    }
    return ops;
  };
  const primaryOps = operatorsOf(primary);
  const consensusOps = operatorsOf(consensus);
  const overlapOperators = [...consensusOps].filter((op) => primaryOps.has(op));

  return {
    ok: overlapEndpoints.length === 0 && overlapOperators.length === 0,
    overlapEndpoints,
    overlapOperators,
    resolutionPartial,
  };
}

/**
 * Reject a 2-of-3 consensus setup whose secondary resolver uses the same
 * strategy (and therefore the same resolvers) as the primary — the second
 * opinion would be a rubber stamp, not an independent check. Logs and
 * returns false so the caller can disable consensus.
 */
export function validateConsensusStrategyDisjointness(
  enabled: boolean,
  primaryStrategy: string,
  consensusStrategy: string,
): boolean {
  if (!enabled) return true;
  if (primaryStrategy === consensusStrategy) {
    getLogger().error(
      {
        primary: primaryStrategy,
        consensus: consensusStrategy,
      },
      'DNS: DNS_CONSENSUS_STRATEGY equals DNS_LOOKUP_STRATEGY — the secondary ' +
        'resolver queries the same resolvers and provides no independent opinion; ' +
        '2-of-3 consensus is disabled',
    );
    return false;
  }
  return true;
}

/**
 * Reject a 2-of-3 consensus setup whose secondary strategy reuses resolver
 * endpoints already queried by the primary. Two different strategy names can
 * still resolve through the same servers (e.g. 'doh-only' vs 'doh-primary'
 * both race the same Cloudflare/Google/Quad9 DoH endpoints), making the
 * second opinion a rubber stamp. Endpoint keys are produced by
 * collectResolverEndpoints(): DoH hostname, DoT host/IP, pinned native
 * nameservers, 'native:system-resolver', or the transport-agnostic
 * 'ip:<address>' markers that expose same-IP overlap across transports.
 */
export function validateConsensusEndpointDisjointness(
  primaryEndpoints: string[],
  consensusEndpoints: string[],
): boolean {
  const primary = new Set(primaryEndpoints);
  const overlap = consensusEndpoints.filter((endpoint) => primary.has(endpoint));
  if (overlap.length === 0) return true;
  getLogger().error(
    { overlap, primary: primaryEndpoints, consensus: consensusEndpoints },
    'DNS: DNS_CONSENSUS_STRATEGY reuses resolver endpoints already queried by the ' +
      `primary (${overlap.join(', ')}) — the secondary is not an independent ` +
      'opinion; 2-of-3 consensus is disabled',
  );
  return false;
}

export async function validateResolverGroups(provider: DnsProvider): Promise<void> {
  const logger = getLogger();
  const probe = PROBE_DOMAINS[Math.floor(Math.random() * PROBE_DOMAINS.length)]!;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const result = await provider.checkAvailability(probe, controller.signal);
    if (
      result.status === 'available' ||
      result.status === 'registered' ||
      result.status === 'unknown'
    ) {
      logger.info(
        { domain: probe, status: result.status },
        'DNS: resolver group validation passed',
      );
    } else {
      logger.warn(
        { domain: probe, status: result.status },
        'DNS: resolver group validation returned unexpected status',
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { domain: probe, err: message },
      'DNS: resolver group validation failed — all groups may be degraded',
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
