import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

const CLOUDFLARE_PRICING_EUR: Record<string, { register: number; renew: number }> = {
  com: { register: 8.5, renew: 8.5 },
  net: { register: 10.25, renew: 10.25 },
  org: { register: 9.05, renew: 9.05 },
  io: { register: 30.2, renew: 30.2 },
  co: { register: 20.0, renew: 20.0 },
  app: { register: 11.15, renew: 11.15 },
  dev: { register: 11.15, renew: 11.15 },
  me: { register: 17.65, renew: 17.65 },
  uk: { register: 5.1, renew: 5.1 },
  de: { register: 7.5, renew: 7.5 },
  fr: { register: 8.0, renew: 8.0 },
  eu: { register: 6.5, renew: 6.5 },
  it: { register: 9.0, renew: 9.0 },
  info: { register: 12.0, renew: 12.0 },
  biz: { register: 11.5, renew: 11.5 },
  ai: { register: 65.0, renew: 65.0 },
  tech: { register: 25.0, renew: 25.0 },
  online: { register: 22.0, renew: 22.0 },
  shop: { register: 18.0, renew: 18.0 },
  store: { register: 35.0, renew: 35.0 },
};

function getTldPricing(tld: string): { register: number; renew: number } | null {
  return CLOUDFLARE_PRICING_EUR[tld.toLowerCase()] ?? null;
}

interface CfApiError {
  code: number;
  message: string;
}

interface CfApiEnvelope<T> {
  success: boolean;
  errors: CfApiError[];
  messages?: Array<{ code: number; message: string }>;
  result?: T | undefined;
}

interface CfDomainResult {
  id: string;
  domain: string;
  expires_at: string;
  auto_renew: boolean;
  locked: boolean;
  name_servers: string[];
  created_at?: string | undefined;
  current_registrar?: string | undefined;
}

function isCfApiEnvelope<T>(v: unknown): v is CfApiEnvelope<T> {
  return (
    typeof v === 'object' &&
    v !== null &&
    'success' in v &&
    Array.isArray((v as Record<string, unknown>).errors)
  );
}

function isCfDomainResult(v: unknown): v is CfDomainResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.domain === 'string';
}

function isCfDomainArray(v: unknown): v is CfDomainResult[] {
  return Array.isArray(v) && v.every(isCfDomainResult);
}

export interface CloudflareRegistrarConfig {
  apiToken: string | undefined;
  accountId: string | undefined;
}

export class CloudflareRegistrarProvider implements RegistrarProvider {
  readonly name = 'cloudflare';
  readonly #apiToken: string | undefined;
  readonly #accountId: string | undefined;

  static readonly registration: RegistrarRegistration = {
    name: 'cloudflare',
    displayName: 'Cloudflare',
    descriptor: {
      name: 'cloudflare',
      displayName: 'Cloudflare',
      description:
        'Cloudflare Registrar offers domain registration at cost price with built-in DNS, DDoS protection, and SSL.',
      website: 'https://www.cloudflare.com/products/registrar/',
      docsUrl: 'https://developers.cloudflare.com/api/operations/registrar-domains-list-domains',
      configFields: [
        {
          key: 'apiToken',
          label: 'API Token',
          type: 'password',
          required: true,
          description: 'Cloudflare API token with Zone:Read and Registrar:Write permissions',
        },
        {
          key: 'accountId',
          label: 'Account ID',
          type: 'string',
          required: true,
          description: 'Cloudflare account ID from the dashboard overview page',
        },
      ],
      supportedTlds: Object.keys(CLOUDFLARE_PRICING_EUR),
      features: [
        'Registration at cost price (no markup)',
        'Integrated DNS, DDoS protection, and SSL',
        'Auto-renewal management',
        'Free WHOIS redaction',
      ],
    },
    create: (config: Record<string, string>) => {
      return new CloudflareRegistrarProvider({
        apiToken: config['apiToken'] ?? config['api_key'] ?? config['APIToken'],
        accountId: config['accountId'] ?? config['account_id'] ?? config['AccountID'],
      });
    },
  };

  constructor(config: CloudflareRegistrarConfig) {
    this.#apiToken = config.apiToken;
    this.#accountId = config.accountId;
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    const managed = await this.#fetchManagedDomains();
    const managedSet = new Set(managed.map((d) => d.domain.toLowerCase()));

    return domains.map((domain) => {
      const tld = domain.split('.').pop() ?? '';
      const pricing = getTldPricing(tld);
      const lower = domain.toLowerCase();
      const isManaged = managedSet.has(lower);

      if (isManaged) {
        return {
          domain,
          available: false,
          registerPriceEur: null,
          renewalPriceEur: pricing?.renew ?? null,
          transferPriceEur: null,
          checkedAt: new Date().toISOString(),
        };
      }

      return {
        domain,
        available: true,
        registerPriceEur: pricing?.register ?? null,
        renewalPriceEur: pricing?.renew ?? null,
        transferPriceEur: pricing?.register ?? null,
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    try {
      const { apiToken, accountId } = this.#validateCredentials();

      const response = await fetch(
        `${CF_API_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(request.domain)}/register`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ years: request.years }),
          signal: AbortSignal.timeout(30_000),
        },
      );

      const body: unknown = await response.json();

      if (!isCfApiEnvelope<CfDomainResult>(body)) {
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: 'Invalid Cloudflare API response format',
        };
      }

      if (!response.ok || !body.success) {
        const msg = body.errors.map((e) => e.message).join('; ');
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: msg || `Cloudflare API error (HTTP ${response.status})`,
        };
      }

      const tld = request.domain.split('.').pop() ?? '';
      const pricing = getTldPricing(tld);

      return {
        domain: request.domain,
        success: true,
        activeAt: body.result?.expires_at,
        priceEur: pricing?.register ?? 0,
        renewalPriceEur: pricing?.renew ?? 0,
        message: 'Domain registered via Cloudflare Registrar',
      };
    } catch (err: unknown) {
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listDomains(): Promise<RegistrarDomainInfo[]> {
    const results = await this.#fetchManagedDomains();
    return results.map((d) => ({
      domain: d.domain,
      registrar: 'cloudflare',
      expiryDate: d.expires_at,
      autoRenew: d.auto_renew,
      locked: d.locked,
      nameServers: d.name_servers,
    }));
  }

  async getRenewalCost(domain: string): Promise<number> {
    const { apiToken, accountId } = this.#validateCredentials();

    try {
      const response = await fetch(
        `${CF_API_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(domain)}`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        throw new ProviderError(
          `Cloudflare API returned HTTP ${response.status} for domain ${domain}`,
          'CloudflareRegistrarProvider',
          'CF_API_ERROR',
        );
      }

      const body: unknown = await response.json();

      if (!isCfApiEnvelope<CfDomainResult>(body) || !body.success || !body.result) {
        throw new ProviderError(
          `Failed to fetch renewal cost for ${domain}`,
          'CloudflareRegistrarProvider',
          'CF_INVALID_RESPONSE',
        );
      }

      const tld = domain.split('.').pop() ?? '';
      const pricing = getTldPricing(tld);

      if (pricing) return pricing.renew;

      throw new ProviderError(
        `Unknown renewal pricing for TLD .${tld} of domain ${domain}`,
        'CloudflareRegistrarProvider',
        'CF_UNKNOWN_TLD',
      );
    } catch (err: unknown) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Renewal cost lookup failed for ${domain}: ${String(err)}`,
        'CloudflareRegistrarProvider',
        'CF_LOOKUP_ERROR',
      );
    }
  }

  async #fetchManagedDomains(): Promise<CfDomainResult[]> {
    const { apiToken, accountId } = this.#validateCredentials();

    const response = await fetch(
      `${CF_API_BASE}/accounts/${accountId}/registrar/domains?per_page=100`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new ProviderError(
        `Cloudflare list domains API returned HTTP ${response.status}`,
        'CloudflareRegistrarProvider',
        'CF_API_ERROR',
      );
    }

    const body: unknown = await response.json();

    if (!isCfApiEnvelope<unknown>(body) || !body.success) {
      throw new ProviderError(
        'Cloudflare API returned unsuccessful response for list domains',
        'CloudflareRegistrarProvider',
        'CF_INVALID_RESPONSE',
      );
    }

    if (!isCfDomainArray(body.result)) {
      return [];
    }

    return body.result;
  }

  #validateCredentials(): { apiToken: string; accountId: string } {
    if (!this.#apiToken || !this.#accountId) {
      throw new ProviderError(
        'Cloudflare API credentials not configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.',
        'CloudflareRegistrarProvider',
        'CF_MISSING_CREDENTIALS',
      );
    }
    return { apiToken: this.#apiToken, accountId: this.#accountId };
  }
}
