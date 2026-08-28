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

/** Runtime consensus validation budget — short, must not slow startup. */
const RUNTIME_VALIDATION_TIMEOUT_MS = 3000;

/** Number of probe domains to query per leg for runtime validation. */
const RUNTIME_PROBE_DOMAINS = ['example.com', 'google.com'];

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
  'doh:dns.opendns.com': 'opendns',
  'doh:dns.digitale-gesellschaft.ch': 'digitale-gesellschaft',
  'doh:doh.libredns.gr': 'libredns',
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
  'ip:208.67.222.222': 'opendns',
  'ip:208.67.220.220': 'opendns',
  'ip:185.95.218.42': 'digitale-gesellschaft',
  'ip:185.95.218.43': 'digitale-gesellschaft',
  'ip:2a05:fc84::42': 'digitale-gesellschaft',
  'ip:2a05:fc84::43': 'digitale-gesellschaft',
  'ip:116.202.176.26': 'libredns',
  'ip:116.202.176.27': 'libredns',
  'ip:2a01:4f8:1c0c:4c5f::2': 'libredns',
  'ip:2a01:4f8:1c0c:4c5f::3': 'libredns',
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
    /**
     * Invoked when at least one DoH hostname could not be resolved at boot,
     * i.e. the check ran without resolved-IP overlap proof (ADR-0065
     * observability). Must never throw — bookkeeping must not take the gate
     * down; the check is fail-open by design (ADR-0063).
     */
    onResolutionPartial?: () => void;
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

  const onPartial = (): void => {
    resolutionPartial = true;
    try {
      options?.onResolutionPartial?.();
    } catch {
      // Bookkeeping must never take the gate down (fail-open by design).
    }
  };

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
    if (ips.length === 0) onPartial();
    for (const ip of ips) primary.add(`ip:${ip}`);
  }
  for (const host of consensusDohHosts) {
    const ips = await resolveFor(host);
    if (ips.length === 0) onPartial();
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
 *
 * `native` is exempt from the equality veto: native is the resolver-agnostic
 * mode whose actual servers are decided by the pinned nameservers, so two
 * native legs can be genuinely independent (two distinct private recursors,
 * e.g. DNS_PRIVACY_MODE with separate DNS_NAMESERVERS and
 * DNS_CONSENSUS_NAMESERVERS) or a rubber stamp (the same recursor) — that
 * distinction is exactly what the endpoint-level disjointness check decides.
 */
export function validateConsensusStrategyDisjointness(
  enabled: boolean,
  primaryStrategy: string,
  consensusStrategy: string,
): boolean {
  if (!enabled) return true;
  if (primaryStrategy === 'native' && consensusStrategy === 'native') return true;
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

/**
 * Runtime disjointness validation for the 2-of-3 consensus gate.
 *
 * Unlike the bootstrap check (validateConsensusDisjointness), this performs
 * LIVE DNS queries through each leg's actual provider and resolves the
 * returned nameserver IPs to detect anycast/IP overlap that hostname-level
 * checks cannot catch (e.g., doh:cloudflare-dns.com vs dot:1.1.1.1 both
 * resolving to 1.1.1.1).
 *
 * Returns a report with overlap details. If overlap is detected, the caller
 * should disable the consensus gate and emit a degraded-run flag.
 *
 * Fail-open on errors: transient boot-time failures must not disable the gate.
 * The check is best-effort observability — the bootstrap check remains the
 * authoritative gate.
 */
/** Runtime validation mode for the 2-of-3 DNS consensus gate. */
export type RuntimeValidationMode = 'strict' | 'permissive';

export interface RuntimeConsensusReport {
  /** False when the two resolver sets are not independent opinions at runtime. */
  ok: boolean;
  /** Shared resolved IP addresses across legs. */
  overlapIPs: string[];
  /** Resolver operators present on BOTH sides (same org over two transports). */
  overlapOperators: string[];
  /** True when at least one leg failed to answer probe queries. */
  partial: boolean;
  /** True when validation was run in strict mode and partial/errors caused veto. */
  runtimeDegraded: boolean;
  /** Human-readable reason if not ok. */
  reason: string | undefined;
}

/**
 * Probe a DNS provider with a domain and extract the nameserver IPs from the result.
 * NodeDnsProvider returns the resolved IPs in the result metadata when available.
 */
async function probeProviderForNameservers(
  provider: DnsProvider,
  domain: string,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_VALIDATION_TIMEOUT_MS);

  try {
    const result = await provider.checkAvailability(domain, controller.signal);
    // Extract nameserver IPs from result if available (NodeDnsProvider populates this)
    const nameservers = (result as unknown as { nameservers?: string[] }).nameservers ?? [];
    return nameservers;
  } catch {
    // Transient failure — return empty, caller tracks partial
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runtime independence check for consensus legs.
 * Queries each provider with probe domains, collects resolved nameserver IPs,
 * and checks for overlap.
 *
 * @param mode - 'strict' vetoes the gate on any partial resolution or transient failure;
 *               'permissive' (default) fails open and logs warning only.
 */
export async function validateRuntimeConsensusDisjointness(
  primaryProvider: DnsProvider,
  consensusProvider: DnsProvider,
  tertiaryProvider?: DnsProvider,
  mode: RuntimeValidationMode = 'permissive',
): Promise<RuntimeConsensusReport> {
  const logger = getLogger();
  const allIPs = new Map<string, Set<string>>(); // legName -> Set of IPs
  const allOperators = new Map<string, Set<string>>(); // legName -> Set of operators
  let partial = false;

  const legs = [
    { name: 'primary', provider: primaryProvider },
    { name: 'consensus', provider: consensusProvider },
    ...(tertiaryProvider ? [{ name: 'tertiary', provider: tertiaryProvider }] : []),
  ];

  for (const leg of legs) {
    const ips = new Set<string>();
    const operators = new Set<string>();

    for (const domain of RUNTIME_PROBE_DOMAINS) {
      const nameservers = await probeProviderForNameservers(leg.provider, domain);
      if (nameservers.length === 0) {
        partial = true;
        continue;
      }
      for (const ip of nameservers) {
        ips.add(ip);
        // Check operator hints
        const opKey = `ip:${ip}`;
        const op = OPERATOR_HINTS[opKey];
        if (op !== undefined) operators.add(op);
      }
    }

    if (ips.size === 0) {
      partial = true;
      logger.warn(
        { leg: leg.name },
        'DNS runtime consensus: leg returned no nameserver IPs for probe domains',
      );
    }

    allIPs.set(leg.name, ips);
    allOperators.set(leg.name, operators);
  }

  // Check pairwise overlap
  const overlapIPs: string[] = [];
  const overlapOperators: string[] = [];

  const primaryIPs = allIPs.get('primary') ?? new Set();
  const consensusIPs = allIPs.get('consensus') ?? new Set();
  const tertiaryIPs = allIPs.get('tertiary') ?? new Set();

  // Primary vs Consensus
  for (const ip of consensusIPs) {
    if (primaryIPs.has(ip)) overlapIPs.push(ip);
  }
  // Primary vs Tertiary
  if (tertiaryProvider) {
    for (const ip of tertiaryIPs) {
      if (primaryIPs.has(ip)) overlapIPs.push(ip);
    }
  }
  // Consensus vs Tertiary
  if (tertiaryProvider) {
    for (const ip of tertiaryIPs) {
      if (consensusIPs.has(ip)) overlapIPs.push(ip);
    }
  }

  // Operator overlap
  const primaryOps = allOperators.get('primary') ?? new Set();
  const consensusOps = allOperators.get('consensus') ?? new Set();
  const tertiaryOps = allOperators.get('tertiary') ?? new Set();

  for (const op of consensusOps) {
    if (primaryOps.has(op)) overlapOperators.push(op);
  }
  if (tertiaryProvider) {
    for (const op of tertiaryOps) {
      if (primaryOps.has(op)) overlapOperators.push(op);
      if (consensusOps.has(op)) overlapOperators.push(op);
    }
  }

  const uniqueOverlapIPs = [...new Set(overlapIPs)];
  const uniqueOverlapOperators = [...new Set(overlapOperators)];

  const ok = uniqueOverlapIPs.length === 0 && uniqueOverlapOperators.length === 0;

  // In strict mode, any partial resolution or transient failure degrades the gate
  // because we cannot prove independence at runtime. In permissive mode, we fail
  // open and just log the degradation.
  const runtimeDegraded = mode === 'strict' && partial && ok;

  let reason: string | undefined;
  if (!ok) {
    const details: string[] = [];
    if (uniqueOverlapIPs.length > 0) details.push(`shared IPs: ${uniqueOverlapIPs.join(', ')}`);
    if (uniqueOverlapOperators.length > 0)
      details.push(`shared operators: ${uniqueOverlapOperators.join(', ')}`);
    reason = `Runtime consensus overlap detected — ${details.join('; ')}`;
    logger.error(
      { overlapIPs: uniqueOverlapIPs, overlapOperators: uniqueOverlapOperators, partial },
      reason,
    );
  } else if (runtimeDegraded) {
    reason =
      'Runtime consensus validation incomplete — some legs did not answer probe queries (strict mode)';
    logger.warn(
      { overlapIPs: uniqueOverlapIPs, overlapOperators: uniqueOverlapOperators, partial },
      reason,
    );
  } else {
    logger.info(
      {
        primaryIPs: primaryIPs.size,
        consensusIPs: consensusIPs.size,
        tertiaryIPs: tertiaryIPs?.size ?? 0,
        partial,
      },
      'DNS runtime consensus: all legs independent',
    );
  }

  return {
    ok: ok && !runtimeDegraded,
    overlapIPs: uniqueOverlapIPs,
    overlapOperators: uniqueOverlapOperators,
    partial,
    runtimeDegraded,
    reason,
  };
}

/**
 * Fallback Isolation Validation (ADR-0063 P0).
 *
 * The 2-of-3 consensus gate must be independent of the primary's MAIN opinion.
 * Emergency fallback legs are excluded from the main disjointness check because
 * a shared fallback can never manufacture an Available verdict (it only answers
 * when the main opinion fails). HOWEVER, if the consensus/tertiary resolver set
 * overlaps with the PRIMARY'S FALLBACK recursor, the consensus is effectively
 * querying the same resolver the primary falls back to — the second opinion is
 * a rubber stamp of the primary's last resort, not an independent check.
 *
 * This validation explicitly detects when the consensus/tertiary endpoint set
 * overlaps with the primary's fallback endpoints (after DNS resolution for
 * DoH hostnames). If overlap is detected, the consensus gate MUST be vetoed.
 */
export interface FallbackIsolationReport {
  /** True when the consensus/tertiary is isolated from the primary's fallback. */
  isolated: boolean;
  /** Shared endpoints between primary fallback and consensus/tertiary. */
  fallbackOverlap: string[];
  /** Primary fallback endpoints that were checked. */
  primaryFallbackEndpoints: string[];
  /** Consensus/tertiary endpoints that were checked. */
  consensusEndpoints: string[];
  /** True when the overlap is caused by a single private recursor used for both
   *  primary fallback and consensus (common in DNS_PRIVACY_MODE with one recursor).
   *  In this case the gate is not truly independent but we allow it in degraded mode. */
  singleRecursorMode: boolean;
  /** Human-readable reason for the degraded state when singleRecursorMode is true. */
  degradedReason?: string;
}

export async function validateFallbackIsolation(
  primaryGroups: DnsResolverGroup[],
  consensusGroups: DnsResolverGroup[],
  consensusNameservers?: string[],
  primaryNameservers?: string[],
  resolveHost?: (host: string) => Promise<string[]>,
): Promise<FallbackIsolationReport> {
  // Extract primary fallback endpoints (groups marked fallback: true)
  const primaryFallbackGroups = primaryGroups.filter((g) => g.fallback === true);

  if (primaryFallbackGroups.length === 0) {
    // No fallback to check against — trivially isolated
    const consensusEndpoints = collectResolverEndpoints(consensusGroups, consensusNameservers, {
      excludeFallbacks: true,
    });
    return {
      isolated: true,
      fallbackOverlap: [],
      primaryFallbackEndpoints: [],
      consensusEndpoints,
      singleRecursorMode: false,
    };
  }

  // Detect single-recursor mode: primary and consensus use the same nameservers
  // AND primary has a fallback group. This is common in DNS_PRIVACY_MODE where
  // a single private recursor serves both primary fallback and consensus.
  const sameNameservers =
    primaryNameservers !== undefined &&
    consensusNameservers !== undefined &&
    primaryNameservers.length > 0 &&
    consensusNameservers.length > 0 &&
    primaryNameservers.join(',') === consensusNameservers.join(',');

  // Collect primary fallback endpoints WITH DNS resolution for DoH hostnames
  // We need resolved IPs to catch cross-transport overlap (DoH hostname -> IP vs DoT IP)
  const primaryFallbackEndpoints = new Set<string>();
  const primaryFallbackDohHosts = collectDohHosts(primaryFallbackGroups, {
    excludeFallbacks: false,
  });

  // Add hostname-level endpoints from fallback groups
  const fallbackCollectOpts = { excludeFallbacks: false };
  const fallbackBase = collectResolverEndpoints(
    primaryFallbackGroups,
    primaryNameservers,
    fallbackCollectOpts,
  );
  for (const ep of fallbackBase) primaryFallbackEndpoints.add(ep);

  // Resolve DoH hostnames from fallback groups to catch anycast/IP overlap
  for (const host of primaryFallbackDohHosts) {
    const ips = await resolveHostAddresses(host, resolveHost);
    for (const ip of ips) primaryFallbackEndpoints.add(`ip:${ip}`);
  }

  // Collect consensus/tertiary endpoints (excluding their own fallbacks if any)
  const consensusCollectOpts = { excludeFallbacks: true };
  const consensusEndpointsSet = new Set(
    collectResolverEndpoints(consensusGroups, consensusNameservers, consensusCollectOpts),
  );

  // Check overlap
  const overlap = [...consensusEndpointsSet].filter((ep) => primaryFallbackEndpoints.has(ep));

  if (overlap.length === 0) {
    return {
      isolated: true,
      fallbackOverlap: [],
      primaryFallbackEndpoints: [...primaryFallbackEndpoints].sort(),
      consensusEndpoints: [...consensusEndpointsSet].sort(),
      singleRecursorMode: false,
    };
  }

  // If overlap exists and it's due to single-recursor mode, VETO the consensus gate.
  // A consensus leg using the same recursor as the primary's fallback is NOT an
  // independent opinion — it's a rubber stamp of the primary's last resort.
  // ADR-0002 conservatism: fail-closed, never degrade to a fake consensus.
  if (sameNameservers) {
    return {
      isolated: false,
      fallbackOverlap: overlap,
      primaryFallbackEndpoints: [...primaryFallbackEndpoints].sort(),
      consensusEndpoints: [...consensusEndpointsSet].sort(),
      singleRecursorMode: true,
      degradedReason: `Single private recursor used for both primary fallback and consensus (${primaryNameservers.join(',')}). Consensus gate VETOED — not an independent second opinion. Configure a distinct recursor via DNS_CONSENSUS_NAMESERVERS to enable consensus.`,
    };
  }

  // Genuine overlap with different resolvers — this is a real independence violation
  return {
    isolated: false,
    fallbackOverlap: overlap,
    primaryFallbackEndpoints: [...primaryFallbackEndpoints].sort(),
    consensusEndpoints: [...consensusEndpointsSet].sort(),
    singleRecursorMode: false,
  };
}
