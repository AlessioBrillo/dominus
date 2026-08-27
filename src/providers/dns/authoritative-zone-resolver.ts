// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../../logger.js';

const logger = getLogger();

/** Well-known authoritative nameservers for major TLDs (fallback when IANA bootstrap unavailable). */
const KNOWN_AUTHORITATIVE_NS: Readonly<Record<string, string[]>> = {
  com: [
    'a.gtld-servers.net',
    'b.gtld-servers.net',
    'c.gtld-servers.net',
    'd.gtld-servers.net',
    'e.gtld-servers.net',
    'f.gtld-servers.net',
    'g.gtld-servers.net',
    'h.gtld-servers.net',
    'i.gtld-servers.net',
    'j.gtld-servers.net',
    'k.gtld-servers.net',
    'l.gtld-servers.net',
    'm.gtld-servers.net',
  ],
  net: [
    'a.gtld-servers.net',
    'b.gtld-servers.net',
    'c.gtld-servers.net',
    'd.gtld-servers.net',
    'e.gtld-servers.net',
    'f.gtld-servers.net',
    'g.gtld-servers.net',
    'h.gtld-servers.net',
    'i.gtld-servers.net',
    'j.gtld-servers.net',
    'k.gtld-servers.net',
    'l.gtld-servers.net',
    'm.gtld-servers.net',
  ],
  org: [
    'a0.org.afilias-nst.info',
    'a2.org.afilias-nst.info',
    'b0.org.afilias-nst.org',
    'b2.org.afilias-nst.org',
    'c0.org.afilias-nst.info',
    'd0.org.afilias-nst.org',
  ],
  info: [
    'a0.info.afilias-nst.info',
    'a2.info.afilias-nst.info',
    'b0.info.afilias-nst.org',
    'b2.info.afilias-nst.org',
    'c0.info.afilias-nst.info',
    'd0.info.afilias-nst.org',
  ],
  biz: [
    'a.gtld-servers.net',
    'b.gtld-servers.net',
    'c.gtld-servers.net',
    'd.gtld-servers.net',
    'e.gtld-servers.net',
    'f.gtld-servers.net',
    'g.gtld-servers.net',
    'h.gtld-servers.net',
    'i.gtld-servers.net',
    'j.gtld-servers.net',
    'k.gtld-servers.net',
    'l.gtld-servers.net',
    'm.gtld-servers.net',
  ],
  // Major ccTLDs with known authoritative sets
  de: ['a.nic.de', 'b.nic.de', 'c.nic.de', 'd.nic.de', 'e.nic.de', 'f.nic.de'],
  uk: [
    'ns1.nic.uk',
    'ns2.nic.uk',
    'ns3.nic.uk',
    'ns4.nic.uk',
    'ns5.nic.uk',
    'ns6.nic.uk',
    'ns7.nic.uk',
  ],
  fr: ['d.nic.fr', 'e.ext.nic.fr', 'f.ext.nic.fr', 'g.ext.nic.fr'],
  jp: [
    'a.dns.jp',
    'b.dns.jp',
    'c.dns.jp',
    'd.dns.jp',
    'e.dns.jp',
    'f.dns.jp',
    'g.dns.jp',
    'h.dns.jp',
  ],
  cn: ['a.dns.cn', 'b.dns.cn', 'c.dns.cn', 'd.dns.cn', 'e.dns.cn', 'f.dns.cn'],
  br: ['a.dns.br', 'b.dns.br', 'c.dns.br', 'd.dns.br', 'e.dns.br', 'f.dns.br'],
  it: ['dns.nic.it', 'dns2.nic.it'],
  nl: ['ns1.dns.nl', 'ns2.dns.nl', 'ns3.dns.nl'],
  eu: ['y1.nic.eu', 'y2.nic.eu', 'y3.nic.eu', 'y4.nic.eu', 'y5.nic.eu', 'y6.nic.eu'],
};

/** IANA Root Zone URL for fetching authoritative NS records. */
const IANA_ROOT_ZONE_URL = 'https://data.iana.org/root-ns/root-ns.xml';

/** Cache TTL for authoritative zone data (24 hours). */
const AUTHORITATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** In-flight resolution deduplication. */
const authoritativeCache = new Map<string, { data: string[]; expiresAt: number }>();
const inFlightResolutions = new Map<string, Promise<string[] | undefined>>();

/**
 * AuthoritativeZoneResolver provides the set of authoritative nameservers for a given TLD.
 * This is used by the DNS consensus gate to verify that secondary/tertiary resolver legs
 * do not query the same authoritative infrastructure as the primary leg — which would
 * make their "independent" opinions a rubber stamp (Consensus Theater).
 *
 * Two data sources:
 * 1. IANA Root Zone (root-ns.xml) - updated periodically, contains all TLD NS records
 * 2. Hardcoded fallbacks for major TLDs - used when IANA fetch fails or for fast path
 */
export class AuthoritativeZoneResolver {
  private readonly fetchIntervalMs: number;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ianaUrl: string;

  constructor(options?: {
    /** Override IANA root zone URL (for testing or air-gapped environments). */
    ianaUrl?: string;
    /** Refresh interval in ms (default: 24h). */
    refreshIntervalMs?: number;
  }) {
    this.ianaUrl = options?.ianaUrl ?? IANA_ROOT_ZONE_URL;
    this.fetchIntervalMs = options?.refreshIntervalMs ?? AUTHORITATIVE_CACHE_TTL_MS;
  }

  /**
   * Start periodic refresh of the IANA root zone.
   * Called at application startup when DNS consensus is enabled.
   */
  start(): void {
    if (this.refreshTimer) return;
    this.refreshCache().catch(() => {}); // Initial fetch, fire-and-forget
    this.refreshTimer = setInterval(() => {
      this.refreshCache().catch(() => {});
    }, this.fetchIntervalMs).unref();
    logger.info(
      { intervalMs: this.fetchIntervalMs },
      'AuthoritativeZoneResolver: started periodic refresh',
    );
  }

  /**
   * Stop periodic refresh.
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logger.info('AuthoritativeZoneResolver: stopped periodic refresh');
    }
  }

  /**
   * Refresh the authoritative zone cache by re-resolving all known TLDs.
   * Called periodically to keep the cache fresh.
   */
  async refreshCache(): Promise<void> {
    const tlds = Array.from(authoritativeCache.keys());
    await Promise.all(
      tlds.map(async (tld) => {
        const result = await this.resolveAuthoritativeNs(tld);
        if (result !== undefined && result.length > 0) {
          authoritativeCache.set(tld, {
            data: result,
            expiresAt: Date.now() + AUTHORITATIVE_CACHE_TTL_MS,
          });
        }
      }),
    );
  }

  /**
   * Get authoritative nameserver hostnames for a TLD.
   * Returns undefined if the TLD is not found in cache and cannot be resolved.
   * Fail-open: returns undefined rather than throwing, so the consensus gate
   * treats it as "cannot prove overlap" rather than failing closed.
   */
  async getAuthoritativeOrigins(tld: string): Promise<string[] | undefined> {
    const normalizedTld = tld.toLowerCase().replace(/^\./, '');

    // Check cache first
    const cached = authoritativeCache.get(normalizedTld);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Deduplicate in-flight resolutions for the same TLD
    const inFlight = inFlightResolutions.get(normalizedTld);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.resolveAuthoritativeNs(normalizedTld).then((result) => {
      inFlightResolutions.delete(normalizedTld);
      if (result !== undefined && result.length > 0) {
        authoritativeCache.set(normalizedTld, {
          data: result,
          expiresAt: Date.now() + AUTHORITATIVE_CACHE_TTL_MS,
        });
      }
      return result;
    });

    inFlightResolutions.set(normalizedTld, promise);
    return promise;
  }

  /**
   * Check if two resolver endpoint sets are disjoint with respect to authoritative zones.
   * Returns true if they are genuinely independent (no shared authoritative NS).
   * Fail-open: if authoritative data unavailable, returns true (cannot prove overlap).
   */
  areZonesDisjoint(tld: string, _primaryOrigins: string[], candidateOrigins: string[]): boolean {
    // This synchronous check uses cached data only.
    // If not cached, we cannot prove overlap -> fail-open (return true).
    const authoritative = authoritativeCache.get(tld.toLowerCase().replace(/^\./, ''));
    if (!authoritative || authoritative.expiresAt <= Date.now()) {
      return true; // Cannot prove overlap
    }

    const authoritativeSet = new Set(
      authoritative.data.map((ns) => ns.toLowerCase().replace(/\.$/, '')),
    );

    // Extract hostnames from candidate origins (e.g., "dot:94.140.14.14" -> "94.140.14.14")
    const candidateHosts = new Set<string>();
    for (const origin of candidateOrigins) {
      const parts = origin.split(':');
      if (parts.length >= 2) {
        const host = parts.slice(1).join(':').toLowerCase();
        // Resolve hostname to IP if needed, but for now match on hostname
        candidateHosts.add(host);
      }
    }

    // Check if any candidate host is in the authoritative set
    for (const host of candidateHosts) {
      if (authoritativeSet.has(host)) {
        return false; // Overlap detected
      }
      // Also check if any authoritative NS hostname matches candidate host
      for (const authNs of authoritativeSet) {
        if (host.includes(authNs) || authNs.includes(host)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Resolve authoritative NS for a TLD from IANA root zone.
   * Falls back to hardcoded known authoritative NS if IANA fetch fails.
   */
  private async resolveAuthoritativeNs(tld: string): Promise<string[] | undefined> {
    // Try hardcoded known authoritative NS first (fast path for major TLDs)
    const known = KNOWN_AUTHORITATIVE_NS[tld];
    if (known !== undefined) {
      logger.debug(
        { tld, count: known.length },
        'AuthoritativeZoneResolver: using known authoritative NS',
      );
      return known;
    }

    // Try to fetch from IANA root zone
    try {
      const response = await fetch(this.ianaUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/xml' },
      });
      if (!response.ok) {
        throw new Error(`IANA root zone fetch failed: ${response.status}`);
      }
      const xml = await response.text();
      const nsRecords = this.parseRootZoneXml(xml, tld);
      if (nsRecords.length > 0) {
        logger.info(
          { tld, count: nsRecords.length },
          'AuthoritativeZoneResolver: resolved from IANA root zone',
        );
        return nsRecords;
      }
    } catch (err) {
      logger.warn(
        { err, tld },
        'AuthoritativeZoneResolver: IANA root zone fetch failed, trying DNS NS query',
      );
    }

    // Fallback: live DNS NS query for the TLD
    try {
      const { default: dns } = await import('node:dns/promises');
      const nsRecords = await Promise.race([
        dns.resolveNs(tld),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
      ]);
      if (nsRecords.length > 0) {
        logger.info(
          { tld, count: nsRecords.length },
          'AuthoritativeZoneResolver: resolved via live DNS NS query',
        );
        return nsRecords.map((ns) => ns.replace(/\.$/, ''));
      }
    } catch (err) {
      logger.warn({ err, tld }, 'AuthoritativeZoneResolver: live DNS NS query failed');
    }

    logger.warn({ tld }, 'AuthoritativeZoneResolver: could not resolve authoritative NS for TLD');
    return undefined;
  }

  /**
   * Parse IANA root-ns.xml to extract NS records for a specific TLD.
   * The XML format: <zone name="com." nserver="a.gtld-servers.net." />
   */
  private parseRootZoneXml(xml: string, targetTld: string): string[] {
    const nsRecords: string[] = [];
    const targetLower = targetTld.toLowerCase();

    try {
      // Simple regex-based parsing (XML is regular enough for this specific format)
      const zoneRegex = /<zone\s+name="([^"]+)"\s+nserver="([^"]+)"\s*\/>/gi;
      let match: RegExpExecArray | null;
      while ((match = zoneRegex.exec(xml)) !== null) {
        if (match[1] !== undefined && match[2] !== undefined) {
          const zoneName = match[1].toLowerCase().replace(/\.$/, '');
          if (zoneName === targetLower) {
            const ns = match[2].toLowerCase().replace(/\.$/, '');
            nsRecords.push(ns);
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, tld: targetTld },
        'AuthoritativeZoneResolver: failed to parse IANA root zone XML',
      );
    }

    return nsRecords;
  }

  /**
   * Get cache stats for observability.
   */
  getCacheStats(): {
    size: number;
    entries: Array<{ tld: string; count: number; expiresInMs: number }>;
  } {
    const entries: Array<{ tld: string; count: number; expiresInMs: number }> = [];
    for (const [tld, data] of authoritativeCache.entries()) {
      entries.push({
        tld,
        count: data.data.length,
        expiresInMs: Math.max(0, data.expiresAt - Date.now()),
      });
    }
    return { size: authoritativeCache.size, entries };
  }
}

/**
 * Factory function to create and start the resolver when DNS consensus is enabled.
 * Returns undefined if DNS consensus is disabled.
 */
export async function createAuthoritativeZoneResolver(
  enabled: boolean,
  options?: { ianaUrl?: string; refreshIntervalMs?: number },
): Promise<AuthoritativeZoneResolver | undefined> {
  if (!enabled) return undefined;
  const resolver = new AuthoritativeZoneResolver(options);
  resolver.start();
  return resolver;
}

/**
 * Synchronous helper for the consensus gate: checks if a resolver leg's endpoint
 * overlaps with the authoritative zone for a TLD.
 * Uses cached data only — fail-open if not available.
 */
export function checkAuthoritativeZoneOverlap(
  resolver: AuthoritativeZoneResolver | undefined,
  tld: string,
  legEndpoints: string[],
): boolean {
  if (!resolver) return false; // No resolver = cannot prove overlap
  return !resolver.areZonesDisjoint(tld, [], legEndpoints);
}
