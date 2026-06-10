import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const DYNADOT_API_BASE = 'https://api.dynadot.com/api2';

const DYNADOT_PRICING_EUR: Record<string, { register: number; renew: number; transfer: number }> = {
  com: { register: 8.99, renew: 8.99, transfer: 8.49 },
  net: { register: 10.99, renew: 10.99, transfer: 10.49 },
  org: { register: 9.49, renew: 9.49, transfer: 8.99 },
  io: { register: 32.99, renew: 32.99, transfer: 32.49 },
  co: { register: 20.99, renew: 20.99, transfer: 20.49 },
  app: { register: 11.99, renew: 11.99, transfer: 11.49 },
  dev: { register: 11.99, renew: 11.99, transfer: 11.49 },
  me: { register: 16.99, renew: 16.99, transfer: 16.49 },
  uk: { register: 5.99, renew: 5.99, transfer: 5.49 },
  de: { register: 7.99, renew: 7.99, transfer: 7.49 },
  fr: { register: 7.99, renew: 7.99, transfer: 7.49 },
  eu: { register: 5.99, renew: 5.99, transfer: 5.49 },
  it: { register: 8.99, renew: 8.99, transfer: 8.49 },
  info: { register: 14.99, renew: 14.99, transfer: 14.49 },
  biz: { register: 11.99, renew: 11.99, transfer: 11.49 },
  ai: { register: 59.99, renew: 59.99, transfer: 59.49 },
  tech: { register: 24.99, renew: 24.99, transfer: 24.49 },
  online: { register: 22.99, renew: 22.99, transfer: 22.49 },
  shop: { register: 18.99, renew: 18.99, transfer: 18.49 },
  store: { register: 34.99, renew: 34.99, transfer: 34.49 },
  xyz: { register: 1.99, renew: 9.99, transfer: 1.49 },
  club: { register: 8.99, renew: 8.99, transfer: 8.49 },
  top: { register: 1.99, renew: 7.99, transfer: 1.49 },
  site: { register: 2.99, renew: 18.99, transfer: 2.49 },
  space: { register: 2.99, renew: 15.99, transfer: 2.49 },
  website: { register: 2.99, renew: 18.99, transfer: 2.49 },
  us: { register: 7.99, renew: 7.99, transfer: 7.49 },
  ca: { register: 12.99, renew: 12.99, transfer: 12.49 },
  in: { register: 6.99, renew: 6.99, transfer: 6.49 },
  co_uk: { register: 6.99, renew: 6.99, transfer: 6.49 },
  org_uk: { register: 5.99, renew: 5.99, transfer: 5.49 },
};

function getTldPricing(tld: string): { register: number; renew: number; transfer: number } | null {
  return DYNADOT_PRICING_EUR[tld.toLowerCase()] ?? null;
}

interface DynadotApiResponse {
  DynadotApiResponse?: {
    Head?: { ResultCode: string; Status: string };
    Body?: Record<string, unknown>;
  };
}

export interface DynadotConfig {
  apiKey: string;
}

export class DynadotRegistrarProvider implements RegistrarProvider {
  readonly name = 'dynadot';
  readonly #config: DynadotConfig;

  static readonly registration: RegistrarRegistration = {
    name: 'dynadot',
    displayName: 'Dynadot',
    descriptor: {
      name: 'dynadot',
      displayName: 'Dynadot',
      description: 'Domain registrar and marketplace with API access. Good for domain investing.',
      website: 'https://www.dynadot.com',
      docsUrl: 'https://www.dynadot.com/domain/api.html',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Dynadot API key from your account settings',
        },
      ],
      supportedTlds: Object.keys(DYNADOT_PRICING_EUR),
      features: [
        'Domain registration and transfer',
        'Domain marketplace and aftermarket',
        'Domain parking',
        'Bulk search and registration',
      ],
    },
    create: (config: Record<string, string>) => {
      return new DynadotRegistrarProvider({ apiKey: config['apiKey'] ?? '' });
    },
  };

  constructor(config: DynadotConfig) {
    this.#config = config;
  }

  #validate(): void {
    if (!this.#config.apiKey) {
      throw new ProviderError(
        'Dynadot API key not configured. Set REGISTRAR_DYNADOT_API_KEY.',
        'DynadotRegistrarProvider',
        'DD_MISSING_CREDENTIALS',
      );
    }
  }

  async #apiCall(
    command: string,
    params: Record<string, string> = {},
  ): Promise<DynadotApiResponse> {
    const query = new URLSearchParams({ key: this.#config.apiKey, command, ...params });
    const response = await fetch(`${DYNADOT_API_BASE}.json?${query.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { DynadotApiResponse: { Head: { ResultCode: '0', Status: 'error' } } };
    }
    return response.json() as Promise<DynadotApiResponse>;
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    this.#validate();
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
      const result = await this.#apiCall('register', {
        domain: request.domain,
        duration: String(request.years),
      });
      const code = result.DynadotApiResponse?.Head?.ResultCode;
      if (code === '1') {
        return {
          domain: request.domain,
          success: true,
          priceEur: pricing?.register ?? 0,
          renewalPriceEur: pricing?.renew ?? 0,
          message: 'Domain registered via Dynadot API',
        };
      }
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: `Dynadot API result code: ${code ?? '0'}`,
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
      const result = await this.#apiCall('list');
      const body = result.DynadotApiResponse?.Body;
      if (body && Array.isArray(body['DomainList'])) {
        return (body['DomainList'] as Array<Record<string, string>>).map((d) => ({
          domain: d['Domain'] ?? '',
          registrar: 'dynadot',
          expiryDate: d['ExpirationDate'] ?? '',
          autoRenew: (d['AutoRenew'] ?? 'N') === 'Y',
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
    const tld = domain.split('.').slice(1).join('.');
    const pricing = getTldPricing(tld);
    if (pricing) return pricing.renew;
    throw new ProviderError(
      `Unknown renewal pricing for TLD .${tld} of domain ${domain}`,
      'DynadotRegistrarProvider',
      'DD_UNKNOWN_TLD',
    );
  }
}
