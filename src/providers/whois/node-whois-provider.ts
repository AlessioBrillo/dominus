import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnectFn } from 'node:tls';
import { extractTld } from '../../utils/domain.js';
import { ProviderError } from '../../types/errors.js';
import type { WhoisProvider, WhoisResult } from './whois-provider.js';
import { resolveWhoisServer } from './iana-server-lookup.js';
import { RateLimiter } from '../rate-limiter.js';
import type { RateLimiterConfig } from '../rate-limiter.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import type { CircuitBreakerPolicy } from '../circuit-breaker.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

const WHOIS_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 3,
  windowMs: 30_000,
  cooldownMs: 60_000,
};

/** WHOIS servers known to support TLS on port 43 (RFC 9541).
 *  Keyed by TLD, same server hostname as WHOIS_SERVERS. The TLS
 *  handshake uses SNI with the server hostname. On TLS failure the
 *  client falls back to plaintext for backward compatibility. */
const WHOIS_TLS_SERVERS: Set<string> = new Set([
  '.com',
  '.net',
  '.org',
  '.de',
  '.eu',
  '.it',
  '.fr',
  '.nl',
  '.se',
  '.ca',
  '.uk',
]);

const WHOIS_SERVERS: Record<string, string> = {
  '.com': 'whois.verisign-grs.com',
  '.net': 'whois.verisign-grs.com',
  '.org': 'whois.pir.org',
  '.io': 'whois.nic.io',
  '.ai': 'whois.nic.ai',
  '.co': 'whois.nic.co',
  '.uk': 'whois.nic.uk',
  '.de': 'whois.denic.de',
  '.eu': 'whois.eu',
  '.it': 'whois.nic.it',
  '.fr': 'whois.nic.fr',
  '.es': 'whois.nic.es',
  '.nl': 'whois.sidn.nl',
  '.se': 'whois.iis.se',
  '.au': 'whois.auda.org.au',
  '.ca': 'whois.cira.ca',
  '.us': 'whois.nic.us',
  '.xyz': 'whois.nic.xyz',
  '.top': 'whois.nic.top',
  '.info': 'whois.afilias.net',
  '.biz': 'whois.neulevel.biz',
  '.name': 'whois.nic.name',
  '.pro': 'whois.registry.pro',
  '.mobi': 'whois.dotmobiregistry.net',
  '.asia': 'whois.nic.asia',
  '.tel': 'whois.nic.tel',
  '.cc': 'whois.nic.cc',
  '.tv': 'whois.nic.tv',
  '.me': 'whois.nic.me',
  '.app': 'whois.nic.google',
  '.dev': 'whois.nic.google',
  '.page': 'whois.nic.google',
};

const NOT_FOUND_PATTERNS = [
  /no match for/i,
  /not found/i,
  /no data found/i,
  /domain not found/i,
  /no entries found/i,
  /status:\s*free/i,
  /the queried object does not exist/i,
  /nothing found/i,
  /is available/i,
  /no matching record/i,
];

/** Connect function for WHOIS servers. Same signature as net.connect().
 *  Use makeTlsConnect() to wrap tls.connect() for TLS-capable servers. */
type WhoisConnectFn = (port: number, host: string, callback?: () => void) => Socket;

/** TLS fallback configuration. When useTls is true, the provider attempts
 *  a TLS connection first, falling back to plaintext on timeout. */
interface TlsConfig {
  useTls: boolean;
  /** TLS connect function matching the net.connect() signature.
   *  Built from tls.connect() with servername SNI. */
  tlsConnect: WhoisConnectFn;
}

export interface NodeWhoisProviderConfig {
  timeoutMs?: number;
  serverOverrides?: Record<string, string>;
  connect?: WhoisConnectFn | undefined;
  defaultRateLimiter?: RateLimiter | undefined;
  perTldRateLimiters?: Record<string, RateLimiter> | undefined;
  /** When true, use TLS connections for WHOIS servers that support it.
   *  Servers in WHOIS_TLS_SERVERS are tried with TLS first; plaintext
   *  fallback on connection timeout. Default: true. */
  tlsEnabled?: boolean;
}

function isAvailable(raw: string): boolean {
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(raw));
}

export function parseWhoisResponse(domain: string, raw: string): WhoisResult {
  const available = isAvailable(raw);

  let registrar: string | undefined;
  let createdDate: string | undefined;
  let expiryDate: string | undefined;

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('registrar:') && registrar === undefined) {
      const val = trimmed.slice('registrar:'.length).trim();
      if (val.length > 0 && !val.startsWith('%') && !val.startsWith('#')) {
        registrar = val;
      }
    }

    if (
      createdDate === undefined &&
      (lower.startsWith('creation date:') ||
        lower.startsWith('created date:') ||
        lower.startsWith('created:') ||
        lower.startsWith('domain registration date:') ||
        lower.startsWith('domain create date:') ||
        lower.startsWith('created_date:') ||
        lower.startsWith('domain_created_date:'))
    ) {
      const val = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (val.length > 0) {
        const parsed = new Date(val);
        if (!isNaN(parsed.getTime())) {
          createdDate = parsed.toISOString();
        }
      }
    }

    if (
      expiryDate === undefined &&
      (lower.startsWith('registry expiry date:') ||
        lower.startsWith('expiry date:') ||
        lower.startsWith('expiration date:') ||
        lower.startsWith('domain expiration date:') ||
        lower.startsWith('paid-till:'))
    ) {
      const val = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (val.length > 0) {
        const parsed = new Date(val);
        if (!isNaN(parsed.getTime())) {
          expiryDate = parsed.toISOString();
        }
      }
    }
  }

  return {
    domain,
    available,
    registrar,
    createdDate,
    expiryDate,
    checkedAt: new Date().toISOString(),
  };
}

function queryWhoisServer(
  host: string,
  domain: string,
  timeoutMs: number,
  connectFn: WhoisConnectFn,
  tlsConfig?: TlsConfig,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onConnect = (): void => {
      socket.write(`${domain}\r\n`);
    };

    const socket: Socket = tlsConfig?.useTls
      ? tlsConfig.tlsConnect(43, host, onConnect)
      : connectFn(43, host, onConnect);

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    socket.setTimeout(timeoutMs);

    socket.on('data', (data: Buffer) => {
      if (settled) return;
      totalBytes += data.length;
      if (totalBytes <= MAX_RESPONSE_BYTES) {
        chunks.push(data);
      }
    });

    socket.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(raw);
    });

    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`WHOIS connection timed out after ${timeoutMs}ms for ${domain} on ${host}`));
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export class NodeWhoisProvider implements WhoisProvider {
  readonly #timeoutMs: number;
  readonly #serverOverrides: Record<string, string>;
  readonly #connectFn: WhoisConnectFn;
  readonly #tlsConnectFn: WhoisConnectFn;
  readonly #defaultRateLimiter: RateLimiter;
  readonly #perTldRateLimiters: Record<string, RateLimiter>;
  readonly #circuitBreaker: CircuitBreaker;
  readonly #tlsEnabled: boolean;

  constructor(config: NodeWhoisProviderConfig = {}) {
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#serverOverrides = config.serverOverrides ?? {};
    this.#connectFn = config.connect ?? netConnect;
    // Build TLS connect function from the config's connect (or fallback to real tls.connect).
    // Tests pass a mock connect function; this ensures the mock is used for TLS too.
    if (config.connect) {
      this.#tlsConnectFn = config.connect;
    } else {
      this.#tlsConnectFn = (port, host, callback): Socket =>
        tlsConnectFn({ port, host, servername: host }, callback);
    }
    this.#defaultRateLimiter = config.defaultRateLimiter ?? RateLimiter.unlimited();
    this.#perTldRateLimiters = config.perTldRateLimiters ?? {};
    this.#circuitBreaker = new CircuitBreaker(WHOIS_CIRCUIT_BREAKER);
    this.#tlsEnabled = config.tlsEnabled ?? true;
  }

  #rateLimiterFor(tld: string): RateLimiter {
    const cleanTld = tld.startsWith('.') ? tld.toLowerCase() : `.${tld.toLowerCase()}`;
    return this.#perTldRateLimiters[cleanTld] ?? this.#defaultRateLimiter;
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<WhoisResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const tld = extractTld(domain);
    const limiter = this.#rateLimiterFor(tld);
    return limiter.throttle(() => this.#doCheckAvailability(domain, signal));
  }

  async #doCheckAvailability(domain: string, _signal?: AbortSignal): Promise<WhoisResult> {
    if (_signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (!this.#circuitBreaker.allow()) {
      throw new ProviderError(
        `WHOIS circuit breaker open for ${domain} — cooldown ${this.#circuitBreaker.cooldownMs}ms remaining`,
        'NodeWhoisProvider',
        'WHOIS_CIRCUIT_OPEN',
      );
    }

    const tld = extractTld(domain);
    if (tld === '') {
      this.#circuitBreaker.onFailure();
      throw new ProviderError(
        `Cannot determine TLD for domain: ${domain}`,
        'NodeWhoisProvider',
        'WHOIS_INVALID_DOMAIN',
      );
    }

    const server = this.#resolveServer(tld);
    if (server === null) {
      throw new ProviderError(
        `No WHOIS server known for TLD ${tld} (domain: ${domain})`,
        'NodeWhoisProvider',
        'WHOIS_NO_SERVER',
      );
    }

    const useTls = this.#tlsEnabled && this.#isTlsForTld(tld);
    const tlsConfig: TlsConfig | undefined = useTls
      ? { useTls: true, tlsConnect: this.#tlsConnectFn }
      : undefined;

    try {
      const raw = await queryWhoisServer(
        server,
        domain,
        this.#timeoutMs,
        this.#connectFn,
        tlsConfig,
      );
      this.#circuitBreaker.onSuccess();
      return parseWhoisResponse(domain, raw);
    } catch (err: unknown) {
      // If TLS connection timed out, retry with plaintext before failing.
      if (
        useTls &&
        err instanceof Error &&
        (err.message.includes('timed out') || err.message.includes('TLS'))
      ) {
        try {
          const raw = await queryWhoisServer(server, domain, this.#timeoutMs, this.#connectFn);
          this.#circuitBreaker.onSuccess();
          return parseWhoisResponse(domain, raw);
        } catch {
          // fall through to the original error below
        }
      }
      this.#circuitBreaker.onFailure();
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(
        `WHOIS lookup failed for ${domain} on ${server}: ${message}`,
        'NodeWhoisProvider',
        'WHOIS_LOOKUP_FAILED',
      );
    }
  }

  #resolveServer(tld: string): string | null {
    const cleanTld = tld.startsWith('.') ? tld : `.${tld}`;
    const lowerTld = cleanTld.toLowerCase();

    const override = this.#serverOverrides[lowerTld];
    if (override !== undefined) return override;

    const builtin = WHOIS_SERVERS[lowerTld];
    if (builtin !== undefined) return builtin;

    return null;
  }

  #isTlsForTld(tld: string): boolean {
    const cleanTld = tld.startsWith('.') ? tld : `.${tld}`;
    return WHOIS_TLS_SERVERS.has(cleanTld.toLowerCase());
  }
}

export class NodeWhoisProviderWithIanaFallback implements WhoisProvider {
  readonly #delegate: NodeWhoisProvider;
  readonly #connectFn: ((port: number, host: string, callback?: () => void) => Socket) | undefined;
  readonly #defaultRateLimiter: RateLimiter;
  readonly #perTldRateLimiters: Record<string, RateLimiter>;
  readonly #tlsEnabled: boolean;

  constructor(config: NodeWhoisProviderConfig = {}) {
    this.#delegate = new NodeWhoisProvider(config);
    this.#connectFn = config.connect;
    this.#defaultRateLimiter = config.defaultRateLimiter ?? RateLimiter.unlimited();
    this.#perTldRateLimiters = config.perTldRateLimiters ?? {};
    this.#tlsEnabled = config.tlsEnabled ?? true;
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<WhoisResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
    const cleanTld = tld.startsWith('.') ? tld.slice(1) : tld;

    try {
      return await this.#delegate.checkAvailability(domain, signal);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'WHOIS_NO_SERVER') {
        const ianaServer = await resolveWhoisServer(cleanTld, this.#connectFn);
        if (ianaServer !== null) {
          // Pass rate limiters to the fallback provider too — the original
          // bug was that IANA-fallback lookups bypassed all rate limiting.
          const providerWithIana = new NodeWhoisProvider({
            connect: this.#connectFn,
            serverOverrides: { [`.${cleanTld}`]: ianaServer },
            defaultRateLimiter: this.#defaultRateLimiter,
            perTldRateLimiters: this.#perTldRateLimiters,
            tlsEnabled: this.#tlsEnabled,
          });
          return providerWithIana.checkAvailability(domain, signal);
        }
      }
      throw err;
    }
  }
}

export function buildPerTldWhoisRateLimiters(
  overridesJson: string | undefined,
  defaultConfig: RateLimiterConfig,
): Record<string, RateLimiter> {
  const limiters: Record<string, RateLimiter> = {};

  if (!overridesJson) return limiters;

  try {
    const parsed = JSON.parse(overridesJson) as Record<string, Partial<RateLimiterConfig>>;
    for (const [tld, cfg] of Object.entries(parsed)) {
      const cleanTld = tld.startsWith('.') ? tld.toLowerCase() : `.${tld.toLowerCase()}`;
      limiters[cleanTld] = new RateLimiter({
        maxTokens: cfg.maxTokens ?? defaultConfig.maxTokens,
        tokensPerInterval: cfg.tokensPerInterval ?? defaultConfig.tokensPerInterval,
        intervalMs: cfg.intervalMs ?? defaultConfig.intervalMs,
      });
    }
  } catch {
    // Invalid JSON — silently fall back to defaults
  }

  return limiters;
}
