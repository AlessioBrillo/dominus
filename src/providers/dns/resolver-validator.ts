import type { DnsProvider } from './dns-provider.js';
import { getLogger } from '../../logger.js';

const PROBE_DOMAINS = ['google.com', 'cloudflare.com', 'github.com'];

const VALIDATION_TIMEOUT_MS = 5000;

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
