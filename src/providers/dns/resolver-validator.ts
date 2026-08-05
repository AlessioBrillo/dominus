// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsProvider } from './dns-provider.js';
import { getLogger } from '../../logger.js';

const PROBE_DOMAINS = ['google.com', 'cloudflare.com', 'github.com'];

const VALIDATION_TIMEOUT_MS = 5000;

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
