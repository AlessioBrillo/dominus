import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const GODADDY_API_BASE = 'https://api.godaddy.com/v1';

const GODADDY_PRICING_EUR: Record<string, { register: number; renew: number; transfer: number }> = {
  com: { register: 11.99, renew: 11.99, transfer: 11.99 },
  net: { register: 13.99, renew: 13.99, transfer: 13.99 },
  org: { register: 11.99, renew: 11.99, transfer: 11.99 },
  io: { register: 39.99, renew: 39.99, transfer: 39.99 },
  co: { register: 27.99, renew: 27.99, transfer: 27.99 },
  app: { register: 14.99, renew: 14.99, transfer: 14.99 },
  dev: { register: 14.99, renew: 14.99, transfer: 14.99 },
  me: { register: 21.99, renew: 21.99, transfer: 21.99 },
  uk: { register: 7.99, renew: 7.99, transfer: 7.99 },
  de: { register: 9.99, renew: 9.99, transfer: 9.99 },
  fr: { register: 9.99, renew: 9.99, transfer: 9.99 },
  eu: { register: 7.99, renew: 7.99, transfer: 7.99 },
  it: { register: 11.99, renew: 11.99, transfer: 11.99 },
  info: { register: 16.99, renew: 16.99, transfer: 16.99 },
  biz: { register: 14.99, renew: 14.99, transfer: 14.99 },
  ai: { register: 74.99, renew: 74.99, transfer: 74.99 },
  tech: { register: 29.99, renew: 29.99, transfer: 29.99 },
  online: { register: 26.99, renew: 26.99, transfer: 26.99 },
  shop: { register: 22.99, renew: 22.99, transfer: 22.99 },
  store: { register: 44.99, renew: 44.99, transfer: 44.99 },
  xyz: { register: 2.99, renew: 12.99, transfer: 2.99 },
  club: { register: 9.99, renew: 9.99, transfer: 9.99 },
  top: { register: 2.99, renew: 8.99, transfer: 2.99 },
  site: { register: 3.99, renew: 21.99, transfer: 3.99 },
  space: { register: 3.99, renew: 19.99, transfer: 3.99 },
  website: { register: 3.99, renew: 21.99, transfer: 3.99 },
  press: { register: 3.99, renew: 23.99, transfer: 3.99 },
  host: { register: 22.99, renew: 32.99, transfer: 22.99 },
  us: { register: 8.99, renew: 8.99, transfer: 8.99 },
  ca: { register: 12.99, renew: 12.99, transfer: 12.99 },
};

function getTldPricing(tld: string): { register: number; renew: number; transfer: number } | null {
  return GODADDY_PRICING_EUR[tld.toLowerCase()] ?? null;
}

interface GoDaddyApiError {
  code: string;
  message: string;
  fields?: Array<{ code: string; message: string; path: string }>;
}

function isGoDaddyApiError(v: unknown): v is GoDaddyApiError {
  return typeof v === 'object' && v !== null && 'code' in v;
}

export interface GoDaddyConfig {
  apiKey: string;
  apiSecret: string;
}

export class GoDaddyRegistrarProvider implements RegistrarProvider {
  readonly name = 'godaddy';
  readonly #config: GoDaddyConfig;

  static readonly registration: RegistrarRegistration = {
    name: 'godaddy',
    displayName: 'GoDaddy',
    descriptor: {
      name: 'godaddy',
      displayName: 'GoDaddy',
      description:
        "World's largest domain registrar. Comprehensive API with full domain management.",
      website: 'https://www.godaddy.com',
      docsUrl: 'https://developer.godaddy.com/doc',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'GoDaddy API key from developer.godaddy.com',
        },
        {
          key: 'apiSecret',
          label: 'API Secret',
          type: 'password',
          required: true,
          description: 'GoDaddy API secret paired with your API key',
        },
      ],
      supportedTlds: Object.keys(GODADDY_PRICING_EUR),
      features: [
        'Domain registration and transfer',
        'DNS zone management',
        'Domain forwarding',
        'Privacy protection',
        'Auction and expired domain access',
      ],
    },
    create: (config: Record<string, string>) => {
      return new GoDaddyRegistrarProvider({
        apiKey: config['apiKey'] ?? '',
        apiSecret: config['apiSecret'] ?? '',
      });
    },
  };

  constructor(config: GoDaddyConfig) {
    this.#config = config;
  }

  #validate(): void {
    if (!this.#config.apiKey || !this.#config.apiSecret) {
      throw new ProviderError(
        'GoDaddy API credentials not configured. Set REGISTRAR_GODADDY_API_KEY and REGISTRAR_GODADDY_API_SECRET.',
        'GoDaddyRegistrarProvider',
        'GD_MISSING_CREDENTIALS',
      );
    }
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `sso-key ${this.#config.apiKey}:${this.#config.apiSecret}`,
      'Content-Type': 'application/json',
    };
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    this.#validate();
    try {
      const response = await fetch(
        `${GODADDY_API_BASE}/domains/available?domain=${domains.map((d) => encodeURIComponent(d)).join(',')}`,
        { headers: this.#headers(), signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return this.#priceFallback(domains);
      const body = (await response.json()) as Record<
        string,
        { available: boolean; price?: number; currency?: string }
      >;
      return domains.map((domain) => {
        const tld = domain.split('.').slice(1).join('.');
        const pricing = getTldPricing(tld);
        const result = body[domain];
        const available = result?.available ?? false;
        const gdPrice = result?.price;
        return {
          domain,
          available,
          registerPriceEur: available ? (gdPrice ?? pricing?.register ?? null) : null,
          renewalPriceEur: pricing?.renew ?? null,
          transferPriceEur: pricing?.register ?? null,
          checkedAt: new Date().toISOString(),
        };
      });
    } catch {
      return this.#priceFallback(domains);
    }
  }

  #priceFallback(domains: string[]): RegistrarPriceCheck[] {
    return domains.map((domain) => {
      const tld = domain.split('.').slice(1).join('.');
      const pricing = getTldPricing(tld);
      return {
        domain,
        available: pricing !== null,
        registerPriceEur: pricing?.register ?? null,
        renewalPriceEur: pricing?.renew ?? null,
        transferPriceEur: pricing?.transfer ?? null,
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    try {
      this.#validate();
      const tld = request.domain.split('.').slice(1).join('.');
      const pricing = getTldPricing(tld);
      const response = await fetch(`${GODADDY_API_BASE}/domains/purchase`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          domain: request.domain,
          consent: {
            agreementKeys: ['DNRA'],
            agreedAt: new Date().toISOString(),
            agreedBy: 'DOMINUS',
          },
          period: request.years,
          renewAuto: true,
          privacy: true,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        return {
          domain: request.domain,
          success: true,
          priceEur: pricing?.register ?? 0,
          renewalPriceEur: pricing?.renew ?? 0,
          message: 'Domain registered via GoDaddy API',
        };
      }
      const body: unknown = await response.json();
      const errMsg = Array.isArray(body)
        ? (body as GoDaddyApiError[]).map((e) => e.message).join('; ')
        : isGoDaddyApiError(body)
          ? body.message
          : `GoDaddy API error (HTTP ${response.status})`;
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: errMsg,
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
    this.#validate();
    try {
      const response = await fetch(`${GODADDY_API_BASE}/domains?statuses=ACTIVE&limit=100`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as Array<Record<string, unknown>>;
      return body.map((d) => ({
        domain: String(d.domain ?? ''),
        registrar: 'godaddy',
        expiryDate: String(d.expires ?? ''),
        autoRenew: d.renewAuto === true,
        locked: false,
        nameServers: Array.isArray(d.nameServers) ? d.nameServers.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  async getRenewalCost(domain: string): Promise<number> {
    this.#validate();
    const tld = domain.split('.').slice(1).join('.');
    const pricing = getTldPricing(tld);
    if (pricing) return pricing.renew;
    throw new ProviderError(
      `Unknown renewal pricing for TLD .${tld} of domain ${domain}`,
      'GoDaddyRegistrarProvider',
      'GD_UNKNOWN_TLD',
    );
  }
}
