import { ProviderError } from '../../types/errors.js';
import { extractRegistrarTld } from '../../utils/domain.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

const PORKBUN_PRICING_EUR: Record<string, { register: number; renew: number; transfer: number }> = {
  com: { register: 8.77, renew: 8.77, transfer: 8.77 },
  net: { register: 9.99, renew: 9.99, transfer: 9.99 },
  org: { register: 8.77, renew: 8.77, transfer: 8.77 },
  io: { register: 28.99, renew: 28.99, transfer: 28.99 },
  co: { register: 18.99, renew: 18.99, transfer: 18.99 },
  app: { register: 11.77, renew: 11.77, transfer: 11.77 },
  dev: { register: 11.77, renew: 11.77, transfer: 11.77 },
  me: { register: 14.99, renew: 14.99, transfer: 14.99 },
  uk: { register: 4.99, renew: 4.99, transfer: 4.99 },
  de: { register: 7.49, renew: 7.49, transfer: 7.49 },
  fr: { register: 7.99, renew: 7.99, transfer: 7.99 },
  eu: { register: 5.99, renew: 5.99, transfer: 5.99 },
  it: { register: 8.99, renew: 8.99, transfer: 8.99 },
  info: { register: 14.99, renew: 14.99, transfer: 14.99 },
  biz: { register: 10.99, renew: 10.99, transfer: 10.99 },
  ai: { register: 59.99, renew: 59.99, transfer: 59.99 },
  tech: { register: 24.99, renew: 24.99, transfer: 24.99 },
  online: { register: 21.99, renew: 21.99, transfer: 21.99 },
  shop: { register: 17.99, renew: 17.99, transfer: 17.99 },
  store: { register: 34.99, renew: 34.99, transfer: 34.99 },
  xyz: { register: 0.99, renew: 9.99, transfer: 0.99 },
  club: { register: 7.99, renew: 7.99, transfer: 7.99 },
  top: { register: 1.99, renew: 6.99, transfer: 1.99 },
  site: { register: 2.99, renew: 16.99, transfer: 2.99 },
  space: { register: 2.99, renew: 14.99, transfer: 2.99 },
  website: { register: 2.99, renew: 16.99, transfer: 2.99 },
  press: { register: 2.99, renew: 18.99, transfer: 2.99 },
  host: { register: 17.99, renew: 24.99, transfer: 17.99 },
  us: { register: 7.99, renew: 7.99, transfer: 7.99 },
  ca: { register: 11.99, renew: 11.99, transfer: 11.99 },
  in: { register: 6.99, renew: 6.99, transfer: 6.99 },
  co_uk: { register: 6.99, renew: 6.99, transfer: 6.99 },
  org_uk: { register: 5.99, renew: 5.99, transfer: 5.99 },
  ac_uk: { register: 6.99, renew: 6.99, transfer: 6.99 },
  uk_net: { register: 5.99, renew: 5.99, transfer: 5.99 },
};

function getTldPricing(tld: string): { register: number; renew: number; transfer: number } | null {
  return PORKBUN_PRICING_EUR[tld.toLowerCase()] ?? null;
}

interface PorkbunApiResponse<T> {
  status: 'SUCCESS' | 'ERROR';
  response?: T;
  error?: string;
}

export interface PorkbunConfig {
  apiKey: string;
  secretApiKey: string;
}

export class PorkbunRegistrarProvider implements RegistrarProvider {
  readonly name = 'porkbun';
  readonly #config: PorkbunConfig;

  static readonly registration: RegistrarRegistration = {
    name: 'porkbun',
    displayName: 'Porkbun',
    descriptor: {
      name: 'porkbun',
      displayName: 'Porkbun',
      description:
        'Developer-friendly domain registrar with clean REST API and competitive pricing.',
      website: 'https://porkbun.com',
      docsUrl: 'https://porkbun.com/api/json/v3/documentation',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Porkbun API key from the API settings page',
        },
        {
          key: 'secretApiKey',
          label: 'Secret API Key',
          type: 'password',
          required: true,
          description: 'Porkbun secret API key paired with your API key',
        },
      ],
      supportedTlds: Object.keys(PORKBUN_PRICING_EUR),
      features: [
        'Domain registration and transfer',
        'Free WHOIS privacy',
        'API-key-based authentication',
        'DNS management',
        'URL forwarding',
      ],
    },
    create: (config: Record<string, string>) => {
      return new PorkbunRegistrarProvider({
        apiKey: config['apiKey'] ?? '',
        secretApiKey: config['secretApiKey'] ?? '',
      });
    },
  };

  constructor(config: PorkbunConfig) {
    this.#config = config;
  }

  #validate(): void {
    if (!this.#config.apiKey || !this.#config.secretApiKey) {
      throw new ProviderError(
        'Porkbun API credentials not configured. Set REGISTRAR_PORKBUN_API_KEY and REGISTRAR_PORKBUN_SECRET_API_KEY.',
        'PorkbunRegistrarProvider',
        'PB_MISSING_CREDENTIALS',
      );
    }
  }

  async #apiPost<T>(
    path: string,
    extra: Record<string, unknown> = {},
  ): Promise<PorkbunApiResponse<T>> {
    const response = await fetch(`${PORKBUN_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: this.#config.apiKey,
        secretapikey: this.#config.secretApiKey,
        ...extra,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.json() as Promise<PorkbunApiResponse<T>>;
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    this.#validate();
    return domains.map((domain) => {
      const tld = extractRegistrarTld(domain);
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
      const tld = extractRegistrarTld(request.domain);
      const pricing = getTldPricing(tld);
      const result = await this.#apiPost<Record<string, unknown>>('/domain/register', {
        domain: request.domain,
        years: request.years,
      });
      if (result.status === 'SUCCESS') {
        return {
          domain: request.domain,
          success: true,
          priceEur: pricing?.register ?? 0,
          renewalPriceEur: pricing?.renew ?? 0,
          activeAt: new Date(Date.now() + request.years * 365 * 24 * 60 * 60 * 1000).toISOString(),
          message: 'Domain registered via Porkbun API',
        };
      }
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: result.error ?? 'Porkbun API error',
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
      const result = await this.#apiPost<{ domains: Array<Record<string, string>> }>(
        '/domain/listAll',
        { start: 0, includeLabels: 'no' },
      );
      if (result.status === 'SUCCESS' && result.response?.domains) {
        return result.response.domains.map((d) => ({
          domain: d.domain ?? '',
          registrar: 'porkbun',
          expiryDate: d.expiry ?? '',
          autoRenew: (d.auto_renew ?? '0') === '1',
          locked: false,
          nameServers: [],
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async getRenewalCost(domain: string): Promise<number> {
    this.#validate();
    const tld = extractRegistrarTld(domain);
    const pricing = getTldPricing(tld);
    if (pricing) return pricing.renew;
    throw new ProviderError(
      `Unknown renewal pricing for TLD ${tld} of domain ${domain}`,
      'PorkbunRegistrarProvider',
      'PB_UNKNOWN_TLD',
    );
  }
}
