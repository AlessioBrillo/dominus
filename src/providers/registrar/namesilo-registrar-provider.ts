import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const NAMESILO_API_BASE = 'https://www.namesilo.com/api';

const NAMESILO_PRICING_EUR: Record<string, { register: number; renew: number; transfer: number }> =
  {
    com: { register: 6.99, renew: 8.99, transfer: 6.99 },
    net: { register: 8.99, renew: 10.99, transfer: 8.99 },
    org: { register: 7.99, renew: 9.99, transfer: 7.99 },
    io: { register: 28.99, renew: 28.99, transfer: 28.99 },
    co: { register: 18.99, renew: 20.99, transfer: 18.99 },
    app: { register: 10.99, renew: 12.99, transfer: 10.99 },
    dev: { register: 10.99, renew: 12.99, transfer: 10.99 },
    me: { register: 12.99, renew: 14.99, transfer: 12.99 },
    uk: { register: 4.99, renew: 5.99, transfer: 4.99 },
    de: { register: 6.99, renew: 7.99, transfer: 6.99 },
    fr: { register: 6.99, renew: 7.99, transfer: 6.99 },
    eu: { register: 4.99, renew: 5.99, transfer: 4.99 },
    it: { register: 7.99, renew: 8.99, transfer: 7.99 },
    info: { register: 12.99, renew: 14.99, transfer: 12.99 },
    biz: { register: 9.99, renew: 11.99, transfer: 9.99 },
    ai: { register: 49.99, renew: 49.99, transfer: 49.99 },
    tech: { register: 20.99, renew: 24.99, transfer: 20.99 },
    online: { register: 18.99, renew: 22.99, transfer: 18.99 },
    shop: { register: 14.99, renew: 18.99, transfer: 14.99 },
    store: { register: 29.99, renew: 34.99, transfer: 29.99 },
    xyz: { register: 0.99, renew: 8.99, transfer: 0.99 },
    club: { register: 5.99, renew: 7.99, transfer: 5.99 },
    top: { register: 0.99, renew: 5.99, transfer: 0.99 },
    site: { register: 1.99, renew: 14.99, transfer: 1.99 },
    space: { register: 1.99, renew: 12.99, transfer: 1.99 },
    website: { register: 1.99, renew: 14.99, transfer: 1.99 },
    us: { register: 5.99, renew: 6.99, transfer: 5.99 },
    ca: { register: 10.99, renew: 11.99, transfer: 10.99 },
    in: { register: 5.99, renew: 6.99, transfer: 5.99 },
    co_uk: { register: 4.99, renew: 5.99, transfer: 4.99 },
    org_uk: { register: 3.99, renew: 4.99, transfer: 3.99 },
  };

function getTldPricing(tld: string): { register: number; renew: number; transfer: number } | null {
  return NAMESILO_PRICING_EUR[tld.toLowerCase()] ?? null;
}

interface NameSiloXmlResponse {
  request: {
    operation: string;
    ip: string;
  };
  reply: {
    code: string;
    detail: string;
    [key: string]: unknown;
  };
}

export interface NameSiloConfig {
  apiKey: string;
}

export class NameSiloRegistrarProvider implements RegistrarProvider {
  readonly name = 'namesilo';
  readonly #config: NameSiloConfig;

  static readonly registration: RegistrarRegistration = {
    name: 'namesilo',
    displayName: 'NameSilo',
    descriptor: {
      name: 'namesilo',
      displayName: 'NameSilo',
      description: 'Budget domain registrar with competitive pricing and a functional XML API.',
      website: 'https://www.namesilo.com',
      docsUrl: 'https://www.namesilo.com/api-reference',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'NameSilo API key from your account dashboard',
        },
      ],
      supportedTlds: Object.keys(NAMESILO_PRICING_EUR),
      features: [
        'Domain registration and transfer',
        'Free WHOIS privacy',
        'Bulk domain management',
        'DNS management',
        'Competitive renewal pricing',
      ],
    },
    create: (config: Record<string, string>) => {
      return new NameSiloRegistrarProvider({ apiKey: config['apiKey'] ?? '' });
    },
  };

  constructor(config: NameSiloConfig) {
    this.#config = config;
  }

  #validate(): void {
    if (!this.#config.apiKey) {
      throw new ProviderError(
        'NameSilo API key not configured. Set REGISTRAR_NAMESILO_API_KEY.',
        'NameSiloRegistrarProvider',
        'NS_MISSING_CREDENTIALS',
      );
    }
  }

  async #apiCall(
    operation: string,
    params: Record<string, string> = {},
  ): Promise<NameSiloXmlResponse> {
    const query = new URLSearchParams({
      version: '1',
      type: 'xml',
      key: this.#config.apiKey,
      operation,
      ...params,
    });
    const response = await fetch(`${NAMESILO_API_BASE}/${operation}?${query.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const match = text.match(/<reply>[\s\S]*?<\/reply>/);
    if (!match) {
      return {
        request: { operation, ip: '' },
        reply: { code: '300', detail: 'Invalid XML response' },
      };
    }
    const code = text.match(/<code>(\d+)<\/code>/)?.[1] ?? '300';
    const detail = text.match(/<detail>([^<]*)<\/detail>/)?.[1] ?? 'Unknown error';
    return {
      request: { operation, ip: '' },
      reply: { code, detail },
    };
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
      const result = await this.#apiCall('registerDomain', {
        domain: request.domain,
        years: String(request.years),
        payment_id: '0',
      });
      if (result.reply.code === '300') {
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: result.reply.detail,
        };
      }
      return {
        domain: request.domain,
        success: true,
        priceEur: pricing?.register ?? 0,
        renewalPriceEur: pricing?.renew ?? 0,
        message: 'Domain registered via NameSilo API',
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
    return [];
  }

  async getRenewalCost(domain: string): Promise<number> {
    this.#validate();
    const tld = domain.split('.').slice(1).join('.');
    const pricing = getTldPricing(tld);
    if (pricing) return pricing.renew;
    throw new ProviderError(
      `Unknown renewal pricing for TLD .${tld} of domain ${domain}`,
      'NameSiloRegistrarProvider',
      'NS_UNKNOWN_TLD',
    );
  }
}
