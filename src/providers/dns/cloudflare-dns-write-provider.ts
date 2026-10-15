// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from '../../types/errors.js';
import type {
  DnsRecord,
  DnsWriteOutcome,
  DnsWriteProvider,
  DnsZoneState,
} from '../../types/dns-write.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

interface CfZone {
  id: string;
  name: string;
  name_servers: string[];
  status: string;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
}

/**
 * Cloudflare DNS write provider (ADR-0083, M3).
 *
 * Manages the zone records of domains whose zone lives in the same
 * Cloudflare account as the registrar integration (the registrar token
 * carries `DNS:Edit` on the account's zones). The provider is the write
 * side only: what the public sees is corroborated by the independent
 * PublicDelegationReader leg of the gate, never by this class.
 *
 * Every method is idempotent — ensureRecords is a no-op that reports no
 * changes when the records already exist with the requested content.
 */
export class CloudflareDnsWriteProvider implements DnsWriteProvider {
  readonly name = 'cloudflare';

  readonly #apiToken: string;
  readonly #fetchImpl: typeof fetch;

  constructor(apiToken: string, fetchImpl: typeof fetch = fetch) {
    this.#apiToken = apiToken;
    this.#fetchImpl = fetchImpl;
  }

  /** Available only with a token: an empty token must skip the step, not fail it. */
  get isAvailable(): boolean {
    return this.#apiToken.length > 0;
  }

  async readZoneState(domain: string): Promise<DnsZoneState | null> {
    const zone = await this.#findZone(domain);
    if (zone === null) return null;

    const records = (await this.#listRecords(zone.id)).map(toDnsRecord);
    return {
      domain,
      managed: true,
      records,
      expectedNameServers: zone.name_servers.map((ns) => normaliseNs(ns)),
    };
  }

  async ensureRecords(domain: string, records: DnsRecord[]): Promise<DnsWriteOutcome> {
    const zone = await this.#findZone(domain);
    if (zone === null) {
      throw new ProviderError(
        `Zone for ${domain} is not managed by Cloudflare`,
        this.name,
        'DNS_ZONE_NOT_MANAGED',
        { domain },
      );
    }

    const existing = await this.#listRecords(zone.id);
    const changed: DnsRecord[] = [];
    const appliedRecords: DnsRecord[] = existing.map(toDnsRecord);

    for (const record of records) {
      const fullName = fullRecordName(record.name, domain);
      const match = existing.find((r) => r.type === record.type && sameName(r.name, fullName));

      if (match && normaliseContent(match.content) === normaliseContent(record.content)) {
        // Already in the desired state: idempotent no-op.
        continue;
      }

      if (match) {
        await this.#request(
          'PATCH',
          `/zones/${zone.id}/dns_records/${encodeURIComponent(match.id)}`,
          { type: record.type, name: fullName, content: record.content, ttl: record.ttl ?? 1 },
        );
      } else {
        await this.#request('POST', `/zones/${zone.id}/dns_records`, {
          type: record.type,
          name: fullName,
          content: record.content,
          ttl: record.ttl ?? 1,
        });
      }

      const applied: DnsRecord = { type: record.type, name: record.name, content: record.content };
      changed.push(applied);
      const appliedIndex = appliedRecords.findIndex(
        (r) => r.type === record.type && sameName(r.name, fullName),
      );
      const absolute: DnsRecord = { type: record.type, name: fullName, content: record.content };
      if (appliedIndex >= 0) {
        appliedRecords[appliedIndex] = absolute;
      } else {
        appliedRecords.push(absolute);
      }
    }

    return {
      domain,
      applied: true,
      records: appliedRecords,
      changed,
      ...(changed.length > 0
        ? { message: `applied ${String(changed.length)} record(s)` }
        : { message: 'records already in the desired state' }),
    };
  }

  async #findZone(domain: string): Promise<CfZone | null> {
    const json = await this.#request<CfZone[]>(
      'GET',
      `/zones?name=${encodeURIComponent(domain)}&status=active&per_page=50`,
    );
    const zone = json.result.find((z) => z.name.toLowerCase() === domain.toLowerCase());
    return zone ?? null;
  }

  async #listRecords(zoneId: string): Promise<CfDnsRecord[]> {
    const json = await this.#request<CfDnsRecord[]>(
      'GET',
      `/zones/${zoneId}/dns_records?per_page=200`,
    );
    return json.result;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<CfApiResponse<T>> {
    let response: Response;
    try {
      response = await this.#fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiToken}`,
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(
        `Cloudflare DNS API network error: ${message}`,
        this.name,
        'DNS_WRITE_NETWORK_ERROR',
        { path },
        err instanceof Error ? err : undefined,
      );
    }

    let json: CfApiResponse<T>;
    try {
      json = (await response.json()) as CfApiResponse<T>;
    } catch (err) {
      throw new ProviderError(
        `Cloudflare DNS API returned HTTP ${String(response.status)} with an unparseable body`,
        this.name,
        'DNS_WRITE_BAD_RESPONSE',
        { path, httpStatus: response.status },
        err instanceof Error ? err : undefined,
      );
    }

    if (!response.ok || !json.success) {
      const message =
        json.errors?.map((e) => e.message).join('; ') ??
        `Cloudflare DNS API returned HTTP ${String(response.status)}`;
      logger.error(
        { path, httpStatus: response.status, error: message },
        'CloudflareDnsWriteProvider: API error',
      );
      throw new ProviderError(message, this.name, 'DNS_WRITE_API_ERROR', {
        path,
        httpStatus: response.status,
      });
    }

    return json;
  }
}

/** Absolute record name + type + content, without the zone id. */
function toDnsRecord(r: CfDnsRecord): DnsRecord {
  return { type: r.type as DnsRecord['type'], name: r.name, content: r.content, ttl: r.ttl };
}

/** '@' or a subdomain relative to the zone -> absolute record name. */
export function fullRecordName(name: string, domain: string): string {
  const cleaned = name.trim().replace(/\.$/, '');
  if (cleaned === '' || cleaned === '@') return domain.toLowerCase();
  if (cleaned.toLowerCase() === domain.toLowerCase()) return cleaned.toLowerCase();
  return `${cleaned}.${domain.toLowerCase()}`;
}

/** Compare absolute record names ignoring case and a trailing dot. */
export function sameName(a: string, b: string): boolean {
  return a.trim().replace(/\.$/, '').toLowerCase() === b.trim().replace(/\.$/, '').toLowerCase();
}

/** Normalise a record content for comparison (case, trailing dot). */
export function normaliseContent(content: string): string {
  return content.trim().replace(/\.$/, '').toLowerCase();
}

/** Normalise a nameserver: lowercase, no trailing dot. */
export function normaliseNs(ns: string): string {
  return ns.trim().replace(/\.$/, '').toLowerCase();
}
