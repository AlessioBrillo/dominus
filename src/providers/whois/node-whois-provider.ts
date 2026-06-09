import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { extractTld } from '../../utils/domain.js';
import { ProviderError } from '../../types/errors.js';
import type { WhoisProvider, WhoisResult } from './whois-provider.js';
import { resolveWhoisServer } from './iana-server-lookup.js';
import { RateLimiter } from '../rate-limiter.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

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

export interface NodeWhoisProviderConfig {
  timeoutMs?: number;
  serverOverrides?: Record<string, string>;
  /** Override the socket factory for testing. Defaults to `node:net.connect`. */
  connect?: ((port: number, host: string, callback?: () => void) => Socket) | undefined;
  /** Rate limiter for WHOIS requests. Defaults to unlimited. */
  rateLimiter?: RateLimiter | undefined;
}

function isAvailable(raw: string): boolean {
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(raw));
}

export function parseWhoisResponse(domain: string, raw: string): WhoisResult {
  const available = isAvailable(raw);

  let registrar: string | undefined;
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
      (lower.startsWith('registry expiry date:') ||
        lower.startsWith('expiry date:') ||
        lower.startsWith('expiration date:') ||
        lower.startsWith('domain expiration date:') ||
        lower.startsWith('paid-till:')) &&
      expiryDate === undefined
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
    expiryDate,
    checkedAt: new Date().toISOString(),
  };
}

function queryWhoisServer(
  host: string,
  domain: string,
  timeoutMs: number,
  connectFn: (port: number, host: string, callback?: () => void) => Socket,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const socket = connectFn(43, host, () => {
      socket.write(`${domain}\r\n`);
    });

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
  readonly #connectFn: (port: number, host: string, callback?: () => void) => Socket;
  readonly #rateLimiter: RateLimiter;

  constructor(config: NodeWhoisProviderConfig = {}) {
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#serverOverrides = config.serverOverrides ?? {};
    this.#connectFn = config.connect ?? netConnect;
    this.#rateLimiter = config.rateLimiter ?? RateLimiter.unlimited();
  }

  async checkAvailability(domain: string): Promise<WhoisResult> {
    return this.#rateLimiter.throttle(() => this.#doCheckAvailability(domain));
  }

  async #doCheckAvailability(domain: string): Promise<WhoisResult> {
    const tld = extractTld(domain);
    if (tld === '') {
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

    try {
      const raw = await queryWhoisServer(server, domain, this.#timeoutMs, this.#connectFn);
      return parseWhoisResponse(domain, raw);
    } catch (err: unknown) {
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
}

export class NodeWhoisProviderWithIanaFallback implements WhoisProvider {
  readonly #delegate: NodeWhoisProvider;
  readonly #connectFn: ((port: number, host: string, callback?: () => void) => Socket) | undefined;

  constructor(config: NodeWhoisProviderConfig = {}) {
    this.#delegate = new NodeWhoisProvider(config);
    this.#connectFn = config.connect;
  }

  async checkAvailability(domain: string): Promise<WhoisResult> {
    const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
    const cleanTld = tld.startsWith('.') ? tld.slice(1) : tld;

    try {
      return await this.#delegate.checkAvailability(domain);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'WHOIS_NO_SERVER') {
        const ianaServer = await resolveWhoisServer(cleanTld, this.#connectFn);
        if (ianaServer !== null) {
          const providerWithIana = new NodeWhoisProvider({
            connect: this.#connectFn,
            serverOverrides: { [`.${cleanTld}`]: ianaServer },
          });
          return providerWithIana.checkAvailability(domain);
        }
      }
      throw err;
    }
  }
}
