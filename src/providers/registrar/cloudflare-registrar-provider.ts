import { ProviderError } from '../../types/errors.js';
import type {
  RegistrarProvider,
  RegistrarPriceCheck,
  RegistrarPurchaseRequest,
  RegistrarPurchaseResult,
  RegistrarDomainInfo,
} from './registrar-provider.js';
import type { RegistrarRegistration } from './registrar-registry.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

interface CfRegistrarDomain {
  id: string;
  domain: string;
  expires_at: string;
  auto_renew: boolean;
  locked: boolean;
  privacy: boolean;
  created_at: string;
  transfer_in: {
    accept_price: number;
    renew_price: number;
    status: string;
    submitted_at: string;
  } | null;
  current_registrar: string;
  available: boolean;
  supported_tld: boolean;
  register_price: number | null;
  renew_price: number | null;
}

export class CloudflareRegistrarProvider implements RegistrarProvider {
  readonly name = 'cloudflare';

  readonly #apiToken: string;
  readonly #accountId: string;

  constructor(apiToken: string, accountId: string) {
    this.#apiToken = apiToken;
    this.#accountId = accountId;
  }

  static readonly registration: RegistrarRegistration = {
    name: 'cloudflare',
    displayName: 'Cloudflare Registrar',
    descriptor: {
      name: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      description:
        'Cloudflare Registrar — at-cost domain registration, renewal, and management via the Cloudflare API v4. Requires an API token with `com.cloudflare.api.account.registrar.domain` read/write permissions and your Cloudflare Account ID.',
      website: 'https://dash.cloudflare.com',
      docsUrl: 'https://developers.cloudflare.com/registrar/',
      configFields: [
        {
          key: 'apiToken',
          label: 'API Token',
          type: 'password',
          required: true,
          description:
            'Cloudflare API token with Registrar:Read and Registrar:Write permissions. Create at https://dash.cloudflare.com/profile/api-tokens',
          placeholder: 'REGISTRAR_CLOUDFLARE_API_TOKEN',
        },
        {
          key: 'accountId',
          label: 'Account ID',
          type: 'string',
          required: true,
          description:
            'Cloudflare Account ID. Find it in the Cloudflare dashboard overview page or under "Account ID" in the API tokens page.',
          placeholder: 'REGISTRAR_CLOUDFLARE_ACCOUNT_ID',
        },
      ],
      supportedTlds: [
        '.com',
        '.net',
        '.org',
        '.io',
        '.ai',
        '.co',
        '.app',
        '.dev',
        '.me',
        '.info',
        '.xyz',
        '.biz',
        '.us',
        '.uk',
        '.de',
        '.fr',
        '.eu',
        '.nl',
      ],
      features: [
        'At-cost domain registration (no markup)',
        'Automatic renewal management',
        'WHOIS privacy (free)',
        'DNSSEC support',
        'List all domains managed via Cloudflare Registrar',
        'Register new domains via API',
      ],
    },
    create: (config: Record<string, string>) => {
      const apiToken = config.apiToken;
      const accountId = config.accountId;
      if (!apiToken || !accountId) {
        throw new ProviderError(
          'Cloudflare Registrar requires both REGISTRAR_CLOUDFLARE_API_TOKEN and REGISTRAR_CLOUDFLARE_ACCOUNT_ID. ' +
            'Set these in your .env file or in a registrar config file (see FILE_REGISTRAR_CONFIG).',
          'cloudflare',
          'REGISTRAR_CONFIG_ERROR',
          { missing: apiToken ? 'accountId' : 'apiToken' },
        );
      }
      return new CloudflareRegistrarProvider(apiToken, accountId);
    },
  };

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    const checkedAt = new Date().toISOString();
    const results: RegistrarPriceCheck[] = [];

    for (const domain of domains) {
      try {
        const info = await this.#fetchDomainInfo(domain);
        if (info && info.available) {
          results.push({
            domain,
            available: true,
            registerPriceEur: info.register_price ?? null,
            renewalPriceEur: info.renew_price ?? null,
            transferPriceEur: info.transfer_in?.renew_price ?? null,
            checkedAt,
          });
        } else if (info && !info.available) {
          results.push({
            domain,
            available: false,
            registerPriceEur: null,
            renewalPriceEur: info.renew_price ?? null,
            transferPriceEur: null,
            checkedAt,
          });
        } else {
          results.push({
            domain,
            available: true,
            registerPriceEur: null,
            renewalPriceEur: null,
            transferPriceEur: null,
            checkedAt,
          });
        }
      } catch {
        results.push({
          domain,
          available: true,
          registerPriceEur: null,
          renewalPriceEur: null,
          transferPriceEur: null,
          checkedAt,
        });
      }
    }

    return results;
  }

  async purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult> {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${this.#accountId}/registrar/domains/${encodeURIComponent(request.domain)}/register`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ years: request.years }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ domain: request.domain, error: msg }, 'Cloudflare register: network error');
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: `Network error contacting Cloudflare API: ${msg}`,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let errorMsg = `Cloudflare API returned HTTP ${response.status}`;
      try {
        const json = JSON.parse(body) as CfApiResponse<unknown>;
        if (json.errors?.length > 0) {
          errorMsg = json.errors.map((e) => e.message).join('; ');
        }
      } catch {
        if (body) errorMsg += `: ${body.slice(0, 200)}`;
      }
      logger.error(
        { domain: request.domain, httpStatus: response.status, error: errorMsg },
        'Cloudflare register: API error',
      );
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: errorMsg,
      };
    }

    let json: CfApiResponse<{ id: string; domain: string; expires_at: string }>;
    try {
      json = (await response.json()) as CfApiResponse<{
        id: string;
        domain: string;
        expires_at: string;
      }>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: `Failed to parse Cloudflare API response: ${msg}`,
      };
    }

    if (!json.success) {
      const errorMsg = json.errors?.map((e) => e.message).join('; ') ?? 'Unknown error';
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: errorMsg,
      };
    }

    const renewPriceEur = await this.getRenewalCost(request.domain);
    return {
      domain: request.domain,
      success: true,
      orderId: json.result.id,
      priceEur: 0,
      renewalPriceEur: renewPriceEur,
      activeAt: json.result.expires_at,
      message: `Domain registered via Cloudflare Registrar. Expires: ${json.result.expires_at}`,
    };
  }

  async listDomains(): Promise<RegistrarDomainInfo[]> {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${this.#accountId}/registrar/domains?per_page=100`;

    let response: Response;
    try {
      response = await fetch(url, { headers: this.#headers() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'Cloudflare list domains: network error');
      return [];
    }

    if (!response.ok) {
      logger.error({ httpStatus: response.status }, 'Cloudflare list domains: API error');
      return [];
    }

    let json: CfApiResponse<CfRegistrarDomain[]>;
    try {
      json = (await response.json()) as CfApiResponse<CfRegistrarDomain[]>;
    } catch {
      return [];
    }

    if (!json.success || !Array.isArray(json.result)) {
      return [];
    }

    return json.result.map((d) => ({
      domain: d.domain,
      registrar: 'cloudflare',
      expiryDate: d.expires_at,
      autoRenew: d.auto_renew,
      locked: d.locked,
      nameServers: [],
    }));
  }

  async getRenewalCost(domain: string): Promise<number> {
    try {
      const info = await this.#fetchDomainInfo(domain);
      if (info?.renew_price != null) return info.renew_price;
    } catch {
      // fall through
    }
    return 0;
  }

  async #fetchDomainInfo(domain: string): Promise<CfRegistrarDomain | null> {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${this.#accountId}/registrar/domains/${encodeURIComponent(domain)}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: this.#headers() });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      const json = (await response.json()) as CfApiResponse<CfRegistrarDomain>;
      if (json.success && json.result) return json.result;
    } catch {
      // ignore parse errors
    }
    return null;
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiToken}`,
      'Content-Type': 'application/json',
    };
  }
}
