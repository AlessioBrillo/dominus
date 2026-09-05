// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * Registry source for operator map updates.
 * Using the public DNS resolver list from DNSCrypt project which is
 * well-maintained and includes operator information.
 */
const REGISTRY_URL =
  'https://raw.githubusercontent.com/DNSCrypt/dnscrypt-resolvers/master/v3/public-resolvers.md';

/** Local cache path for the operator map */
function getCachePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cacheDir = join(here, '..', '..', '..', 'data', 'dns-operator-map');
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return join(cacheDir, 'operator-map.json');
}

/** Version file path */
function getVersionPath(): string {
  const cachePath = getCachePath();
  return cachePath.replace('.json', '-version.txt');
}

/** Embedded fallback operator map (current OPERATOR_HINTS) */
export const EMBEDDED_OPERATOR_MAP: Readonly<Record<string, string>> = {
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
  'dot:1.1.1.1': 'cloudflare',
  'dot:1.0.0.1': 'cloudflare',
  'dot:8.8.8.8': 'google',
  'dot:8.8.4.4': 'google',
  'dot:9.9.9.9': 'quad9',
  'dot:149.112.112.112': 'quad9',
  'dot:94.140.14.14': 'adguard',
  'dot:94.140.15.15': 'adguard',
  'dot:194.242.2.2': 'mullvad',
  'dot:193.138.218.74': 'mullvad',
  'dot:45.90.28.2': 'nextdns',
  'dot:45.90.30.2': 'nextdns',
  'native:1.1.1.1': 'cloudflare',
  'native:1.0.0.1': 'cloudflare',
  'native:8.8.8.8': 'google',
  'native:8.8.4.4': 'google',
  'native:9.9.9.9': 'quad9',
  'native:149.112.112.112': 'quad9',
  'native:94.140.14.14': 'adguard',
  'native:94.140.15.15': 'adguard',
  'native:194.242.2.2': 'mullvad',
  'native:193.138.218.74': 'mullvad',
  'native:45.90.28.2': 'nextdns',
  'native:45.90.30.2': 'nextdns',
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

/** Parsed operator map structure */
export interface OperatorMap {
  /** Map from endpoint identity (e.g., 'doh:cloudflare-dns.com', 'ip:1.1.1.1') to operator name */
  identityToOperator: ReadonlyMap<string, string>;
  /** Map from operator name to set of endpoint identities */
  operatorToIdentities: ReadonlyMap<string, ReadonlySet<string>>;
  /** Version string from registry (date/hash) */
  version: string;
  /** When the map was loaded/updated (ISO timestamp) */
  loadedAt: string;
  /** Source of the map: 'embedded' | 'registry' */
  source: 'embedded' | 'registry';
}

/** In-memory cache */
let cachedOperatorMap: OperatorMap | null = null;

/**
 * Parse the DNSCrypt public-resolvers.md file to extract operator information.
 * The file is in markdown format with resolver entries containing:
 * - resolver_name
 * - provider_name (operator)
 * - ipv4_address / ipv6_address
 * - doh_uri / dot_uri / sdns_stamp
 */
async function parseRegistryMarkdown(markdown: string): Promise<Record<string, string>> {
  const identityToOperator: Record<string, string> = {};

  // The DNSCrypt public-resolvers.md has entries like:
  // ## Resolver Name
  // - **Provider**: Provider Name
  // - **IPv4**: 1.2.3.4
  // - **IPv6**: 2001:db8::1
  // - **DoH**: https://doh.example.com/dns-query
  // - **DoT**: dot.example.com:853
  // - **SDNS Stamp**: sdns://...

  const sections = markdown.split('## ').slice(1); // Skip content before first ##

  for (const section of sections) {
    const lines = section.split('\n');
    const resolverName = lines[0]?.trim() || '';
    if (!resolverName) continue;

    let provider: string | null = null;
    const ips: string[] = [];
    const dohUris: string[] = [];
    const dotUris: string[] = [];

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- **Provider**:')) {
        provider = trimmed
          .replace('- **Provider**:', '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-');
      } else if (trimmed.startsWith('- **IPv4**:')) {
        ips.push(trimmed.replace('- **IPv4**:', '').trim());
      } else if (trimmed.startsWith('- **IPv6**:')) {
        ips.push(trimmed.replace('- **IPv6**:', '').trim());
      } else if (trimmed.startsWith('- **DoH**:')) {
        const uri = trimmed.replace('- **DoH**:', '').trim();
        try {
          const url = new URL(uri);
          dohUris.push(url.hostname);
        } catch {
          // Invalid URI, skip
        }
      } else if (trimmed.startsWith('- **DoT**:')) {
        dotUris.push(trimmed.replace('- **DoT**:', '').trim());
      }
    }

    if (!provider) continue;

    // Normalize provider name to match our convention
    const normalizedProvider = normalizeOperatorName(provider);

    // Add IP identities
    for (const ip of ips) {
      identityToOperator[`ip:${ip}`] = normalizedProvider;
    }

    // Add DoH identities
    for (const host of dohUris) {
      identityToOperator[`doh:${host}`] = normalizedProvider;
    }

    // Add DoT identities
    for (const host of dotUris) {
      identityToOperator[`dot:${host}`] = normalizedProvider;
    }

    // Add native identities (same IPs)
    for (const ip of ips) {
      identityToOperator[`native:${ip}`] = normalizedProvider;
    }
  }

  return identityToOperator;
}

/** Normalize operator name to our convention */
function normalizeOperatorName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Map known providers to our canonical names
  const canonicalMap: Record<string, string> = {
    cloudflare: 'cloudflare',
    google: 'google',
    quad9: 'quad9',
    adguard: 'adguard',
    mullvad: 'mullvad',
    nextdns: 'nextdns',
    opendns: 'opendns',
    'cisco-opendns': 'opendns',
    'digitale-gesellschaft': 'digitale-gesellschaft',
    'digitale-gesellschaft-ch': 'digitale-gesellschaft',
    libredns: 'libredns',
    'libre-dns': 'libredns',
    dnswarden: 'dnswarden',
    'dns-sb': 'dns-sb',
    'tiar-app': 'tiar-app',
    powerdns: 'powerdns',
  };

  return canonicalMap[normalized] || normalized;
}

/**
 * Load operator map from local cache.
 * Returns null if cache doesn't exist or is invalid.
 */
function loadFromCache(): OperatorMap | null {
  const cachePath = getCachePath();
  const versionPath = getVersionPath();

  if (!existsSync(cachePath) || !existsSync(versionPath)) {
    return null;
  }

  try {
    const version = readFileSync(versionPath, 'utf-8').trim();
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      identityToOperator: Record<string, string>;
      loadedAt: string;
      source: 'embedded' | 'registry';
    };

    // Build reverse map
    const operatorToIdentities = new Map<string, Set<string>>();
    for (const [identity, operator] of Object.entries(parsed.identityToOperator)) {
      if (!operatorToIdentities.has(operator)) {
        operatorToIdentities.set(operator, new Set());
      }
      operatorToIdentities.get(operator)!.add(identity);
    }

    // Convert Sets to ReadonlySets
    const readonlyOperatorToIdentities = new Map<string, ReadonlySet<string>>();
    for (const [op, ids] of operatorToIdentities) {
      readonlyOperatorToIdentities.set(op, ids);
    }

    return {
      identityToOperator: new Map(Object.entries(parsed.identityToOperator)),
      operatorToIdentities: readonlyOperatorToIdentities,
      version,
      loadedAt: parsed.loadedAt,
      source: parsed.source,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to load operator map from cache');
    return null;
  }
}

/**
 * Save operator map to local cache.
 */
function saveToCache(map: OperatorMap): void {
  try {
    const cachePath = getCachePath();
    const versionPath = getVersionPath();

    // Convert Map to plain object for JSON serialization
    const obj = {
      identityToOperator: Object.fromEntries(map.identityToOperator),
      loadedAt: map.loadedAt,
      source: map.source,
    };

    writeFileSync(cachePath, JSON.stringify(obj, null, 2));
    writeFileSync(versionPath, map.version);
  } catch (err) {
    logger.warn({ err }, 'Failed to save operator map to cache');
  }
}

/**
 * Fetch and parse operator map from the public registry.
 * Returns null on failure (caller should fall back to embedded).
 */
async function fetchFromRegistry(): Promise<OperatorMap | null> {
  try {
    logger.info('Fetching DNS operator map from registry...');

    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: 'text/markdown' },
      // 10 second timeout
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Registry fetch failed');
      return null;
    }

    const markdown = await response.text();
    const identityToOperator = await parseRegistryMarkdown(markdown);

    if (Object.keys(identityToOperator).length === 0) {
      logger.warn('Registry parse returned empty map');
      return null;
    }

    // Merge with embedded to ensure we don't lose any known mappings
    const merged: Record<string, string> = { ...EMBEDDED_OPERATOR_MAP, ...identityToOperator };

    // Build reverse map
    const operatorToIdentities = new Map<string, Set<string>>();
    for (const [identity, operator] of Object.entries(merged)) {
      if (!operatorToIdentities.has(operator)) {
        operatorToIdentities.set(operator, new Set());
      }
      operatorToIdentities.get(operator)!.add(identity);
    }

    const readonlyOperatorToIdentities = new Map<string, ReadonlySet<string>>();
    for (const [op, ids] of operatorToIdentities) {
      readonlyOperatorToIdentities.set(op, ids);
    }

    const now = new Date().toISOString();
    // Use current date as version (registry doesn't have explicit version)
    const versionParts = now.split('T');
    const version: string = versionParts[0] ?? now; // YYYY-MM-DD

    const result: OperatorMap = {
      identityToOperator: new Map(Object.entries(merged)),
      operatorToIdentities: readonlyOperatorToIdentities,
      version,
      loadedAt: now,
      source: 'registry',
    };

    saveToCache(result);
    logger.info(
      {
        entries: merged.length,
        operators: readonlyOperatorToIdentities.size,
        version,
      },
      'Operator map loaded from registry',
    );

    return result;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch operator map from registry');
    return null;
  }
}

/**
 * Get the operator map, loading from cache/registry/embedded as needed.
 * This is the main entry point - call at startup.
 */
export async function getOperatorMap(): Promise<OperatorMap> {
  if (cachedOperatorMap) {
    return cachedOperatorMap;
  }

  // Try cache first (fast, no network)
  const cached = loadFromCache();
  if (cached) {
    // Check if cache is stale (>7 days)
    const cacheAge = Date.now() - new Date(cached.loadedAt).getTime();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    if (cacheAge < maxAge) {
      logger.info(
        {
          version: cached.version,
          ageDays: Math.round(cacheAge / (24 * 60 * 60 * 1000)),
          source: cached.source,
        },
        'Using cached operator map',
      );
      cachedOperatorMap = cached;
      return cached;
    }

    logger.info(
      { version: cached.version, ageDays: Math.round(cacheAge / (24 * 60 * 60 * 1000)) },
      'Operator map cache stale, refreshing',
    );
  }

  // Try registry
  const fromRegistry = await fetchFromRegistry();
  if (fromRegistry) {
    cachedOperatorMap = fromRegistry;
    return fromRegistry;
  }

  // Fall back to embedded
  logger.warn('Using embedded operator map (registry unavailable, cache stale/missing)');

  // Build from embedded
  const operatorToIdentities = new Map<string, Set<string>>();
  for (const [identity, operator] of Object.entries(EMBEDDED_OPERATOR_MAP)) {
    if (!operatorToIdentities.has(operator)) {
      operatorToIdentities.set(operator, new Set());
    }
    operatorToIdentities.get(operator)!.add(identity);
  }

  const readonlyOperatorToIdentities = new Map<string, ReadonlySet<string>>();
  for (const [op, ids] of operatorToIdentities) {
    readonlyOperatorToIdentities.set(op, ids);
  }

  const embeddedMap: OperatorMap = {
    identityToOperator: new Map(Object.entries(EMBEDDED_OPERATOR_MAP)),
    operatorToIdentities: readonlyOperatorToIdentities,
    version: 'embedded',
    loadedAt: new Date().toISOString(),
    source: 'embedded',
  };

  cachedOperatorMap = embeddedMap;
  return embeddedMap;
}

/**
 * Get operator for a given endpoint identity.
 * Returns undefined if not found.
 */
export async function getOperatorForIdentity(identity: string): Promise<string | undefined> {
  const map = await getOperatorMap();
  return map.identityToOperator.get(identity);
}

/**
 * Get all identities for a given operator.
 */
export async function getIdentitiesForOperator(
  operator: string,
): Promise<ReadonlySet<string> | undefined> {
  const map = await getOperatorMap();
  return map.operatorToIdentities.get(operator);
}

/**
 * Check if two endpoint identities belong to the same operator.
 */
export async function areSameOperator(identityA: string, identityB: string): Promise<boolean> {
  const [opA, opB] = await Promise.all([
    getOperatorForIdentity(identityA),
    getOperatorForIdentity(identityB),
  ]);
  return opA !== undefined && opA === opB;
}

/**
 * Get the current operator map version for metrics/observability.
 */
export async function getOperatorMapVersion(): Promise<string> {
  const map = await getOperatorMap();
  return map.version;
}

/**
 * Get the operator map source for metrics.
 */
export async function getOperatorMapSource(): Promise<'embedded' | 'registry'> {
  const map = await getOperatorMap();
  return map.source;
}

/**
 * Force refresh the operator map from registry (bypasses cache).
 * Useful for manual refresh or scheduled job.
 */
export async function refreshOperatorMap(): Promise<OperatorMap> {
  cachedOperatorMap = null;
  const fromRegistry = await fetchFromRegistry();
  if (fromRegistry) {
    return fromRegistry;
  }
  return getOperatorMap(); // Will fall back to embedded
}

/**
 * Clear the in-memory cache (for testing).
 */
export function clearOperatorMapCache(): void {
  cachedOperatorMap = null;
}
