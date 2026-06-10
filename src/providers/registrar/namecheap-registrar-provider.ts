import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';

const NAMECHEAP_API_BASE = 'https://api.namecheap.com/xml.response';

const NAMECHEAP_PRICING_EUR: Record<string, { register: number; renew: number; transfer: number }> =
  {
    com: { register: 8.98, renew: 8.98, transfer: 8.98 },
    net: { register: 11.98, renew: 11.98, transfer: 11.98 },
    org: { register: 9.98, renew: 9.98, transfer: 9.98 },
    io: { register: 34.88, renew: 34.88, transfer: 34.88 },
    co: { register: 22.88, renew: 22.88, transfer: 22.88 },
    app: { register: 12.98, renew: 12.98, transfer: 12.98 },
    dev: { register: 12.98, renew: 12.98, transfer: 12.98 },
    me: { register: 18.88, renew: 18.88, transfer: 18.88 },
    uk: { register: 6.98, renew: 6.98, transfer: 6.98 },
    de: { register: 8.48, renew: 8.48, transfer: 8.48 },
    fr: { register: 8.98, renew: 8.98, transfer: 8.98 },
    eu: { register: 6.98, renew: 6.98, transfer: 6.98 },
    it: { register: 9.98, renew: 9.98, transfer: 9.98 },
    info: { register: 13.98, renew: 13.98, transfer: 13.98 },
    biz: { register: 12.98, renew: 12.98, transfer: 12.98 },
    ai: { register: 69.88, renew: 69.88, transfer: 69.88 },
    tech: { register: 26.88, renew: 26.88, transfer: 26.88 },
    online: { register: 24.88, renew: 24.88, transfer: 24.88 },
    shop: { register: 19.88, renew: 19.88, transfer: 19.88 },
    store: { register: 38.88, renew: 38.88, transfer: 38.88 },
    xyz: { register: 1.98, renew: 9.98, transfer: 1.98 },
    club: { register: 8.98, renew: 8.98, transfer: 8.98 },
    top: { register: 1.98, renew: 7.98, transfer: 1.98 },
    site: { register: 2.98, renew: 18.88, transfer: 2.98 },
    space: { register: 2.98, renew: 16.88, transfer: 2.98 },
    website: { register: 2.98, renew: 18.88, transfer: 2.98 },
    press: { register: 2.98, renew: 20.88, transfer: 2.98 },
    host: { register: 19.88, renew: 28.88, transfer: 19.88 },
    co_uk: { register: 11.98, renew: 11.98, transfer: 11.98 },
    org_uk: { register: 8.98, renew: 8.98, transfer: 8.98 },
    me_uk: { register: 8.98, renew: 8.98, transfer: 8.98 },
  };

function getTldPricing(tld: string): { register: number; renew: number; transfer: number } | null {
  return NAMECHEAP_PRICING_EUR[tld.toLowerCase()] ?? null;
}

export interface NamecheapConfig {
  apiKey: string;
  username: string;
  clientIp: string;
}

export class NamecheapRegistrarProvider implements RegistrarProvider {
  readonly name = 'namecheap';
  readonly #config: NamecheapConfig;

  static readonly registration: RegistrarRegistration = {
    name: 'namecheap',
    displayName: 'Namecheap',
    descriptor: {
      name: 'namecheap',
      displayName: 'Namecheap',
      description: 'Popular domain registrar with a comprehensive API. Supports 1000+ TLDs.',
      website: 'https://www.namecheap.com',
      docsUrl: 'https://www.namecheap.com/support/api/intro/',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Namecheap API key from your account dashboard',
        },
        {
          key: 'username',
          label: 'Username',
          type: 'string',
          required: true,
          description: 'Your Namecheap account username',
        },
        {
          key: 'clientIp',
          label: 'Client IP',
          type: 'string',
          required: true,
          description: 'Whitelisted IP address for API access',
          placeholder: '1.2.3.4',
        },
      ],
      supportedTlds: Object.keys(NAMECHEAP_PRICING_EUR),
      features: [
        'Domain registration and transfer',
        'DNS management',
        'WhoisGuard privacy protection',
        'Auto-renewal management',
      ],
    },
    create: (config: Record<string, string>) => {
      const apiKey = config['apiKey'] ?? '';
      const username = config['username'] ?? '';
      const clientIp = config['clientIp'] ?? '';
      if (!apiKey || !username || !clientIp) {
        return new NamecheapRegistrarProvider({ apiKey, username, clientIp });
      }
      return new NamecheapRegistrarProvider({ apiKey, username, clientIp });
    },
  };

  constructor(config: NamecheapConfig) {
    this.#config = config;
  }

  #validate(): void {
    if (!this.#config.apiKey || !this.#config.username || !this.#config.clientIp) {
      throw new ProviderError(
        'Namecheap API credentials not configured. Set REGISTRAR_NAMECHEAP_API_KEY, REGISTRAR_NAMECHEAP_USERNAME, and REGISTRAR_NAMECHEAP_CLIENT_IP.',
        'NamecheapRegistrarProvider',
        'NC_MISSING_CREDENTIALS',
      );
    }
  }

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    this.#validate();
    return domains.map((domain) => {
      const labels = domain.split('.');
      const tld = labels.length >= 2 ? labels.slice(1).join('.') : '';
      const pricing = getTldPricing(tld);
      const available = pricing !== null;
      if (!available) {
        return {
          domain,
          available: false,
          registerPriceEur: null,
          renewalPriceEur: null,
          transferPriceEur: null,
          checkedAt: new Date().toISOString(),
        };
      }
      return {
        domain,
        available: true,
        registerPriceEur: pricing.register,
        renewalPriceEur: pricing.renew,
        transferPriceEur: pricing.register,
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    try {
      this.#validate();
      const pricing = getTldPricing(request.domain.split('.').slice(1).join('.'));
      const ncxResponse = await this.#apiCall('namecheap.domains.create', {
        DomainName: request.domain,
        Years: String(request.years),
      });
      if (ncxResponse.success) {
        return {
          domain: request.domain,
          success: true,
          priceEur: pricing?.register ?? 0,
          renewalPriceEur: pricing?.renew ?? 0,
          activeAt: new Date(Date.now() + request.years * 365 * 24 * 60 * 60 * 1000).toISOString(),
          message: 'Domain registration initiated via Namecheap API',
        };
      }
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: ncxResponse.error ?? 'Namecheap API returned an unspecified failure',
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
      const response = await this.#apiCall('namecheap.domains.getList', { PageSize: '100' });
      if (response.success && Array.isArray(response.data)) {
        return response.data.map((d: Record<string, string>) => ({
          domain: d.DomainName ?? '',
          registrar: 'namecheap',
          expiryDate: d.Expires ?? '',
          autoRenew: (d.AutoRenew ?? 'false') === 'true',
          locked: (d.IsLocked ?? 'false') === 'true',
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
      'NamecheapRegistrarProvider',
      'NC_UNKNOWN_TLD',
    );
  }

  async #apiCall(
    command: string,
    params: Record<string, string>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const query = new URLSearchParams({
      ApiUser: this.#config.username,
      ApiKey: this.#config.apiKey,
      UserName: this.#config.username,
      ClientIp: this.#config.clientIp,
      Command: command,
      ...params,
    });
    const url = `${NAMECHEAP_API_BASE}?${query.toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return {
        success: false,
        error: `Namecheap API returned HTTP ${response.status}`,
      };
    }
    const text = await response.text();
    if (text.includes('<ApiResponse Status="OK"')) {
      return { success: true, data: text };
    }
    return { success: false, error: 'Namecheap API returned non-OK status' };
  }
}
