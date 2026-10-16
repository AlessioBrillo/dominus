// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dynadot Registrar provider (ADR-0086, M8b).
 *
 * UNVERIFIED (ADR-0082): this adapter has not been exercised against the
 * real Dynadot API. It ships behind the RegistrarProvider interface so it
 * can be enabled once the operator has verified API access. Until then it
 * is listed in the catalog as `verified: false` and should not be used for
 * automated purchases without manual verification.
 *
 * Dynadot API documentation: https://developers.dynadot.com/
 * Base URL: https://api.dynadot.com/api3/
 */

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

const DYNADOT_API_BASE = 'https://api.dynadot.com/api3';

interface DynadotApiResponse {
  status: string;
  error_message?: string;
  'domain-search'?: Array<{
    'domain-name': string;
    'is-available': boolean;
    'register-price': number;
    'renew-price': number;
    'transfer-price': number;
  }>;
  'domain-register'?: Array<{
    'domain-name': string;
    status: string;
    'order-id': string;
    price: number;
  }>;
  'domain-info'?: Array<{
    'domain-name': string;
    'expire-date': string;
    'auto-renew': boolean;
    'lock-status': boolean;
    'name-servers': string[];
  }>;
}

export class DynadotRegistrarProvider implements RegistrarProvider {
  readonly name = 'dynadot';

  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  static readonly registration: RegistrarRegistration = {
    name: 'dynadot',
    displayName: 'Dynadot',
    descriptor: {
      name: 'dynadot',
      displayName: 'Dynadot',
      description:
        'Dynadot domain registration via API v3. Requires an API key from your Dynadot account. UNVERIFIED against the real Dynadot API (ADR-0082) — enable only after verifying credentials.',
      website: 'https://www.dynadot.com/',
      docsUrl: 'https://developers.dynadot.com/',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Dynadot API key. Create at https://www.dynadot.com/account/settings/api',
          placeholder: 'REGISTRAR_DYNADOT_API_KEY',
        },
      ],
      supportedTlds: [
        '.com',
        '.net',
        '.org',
        '.io',
        '.co',
        '.it',
        '.eu',
        '.shop',
        '.online',
        '.site',
      ],
      features: [
        'Domain registration via API',
        'Domain renewal via API',
        'Domain list via API',
        'WHOIS privacy',
      ],
    },
    create: (config: Record<string, string>) => {
      const apiKey = config.apiKey;
      if (!apiKey) {
        throw new ProviderError(
          'Dynadot Registrar requires REGISTRAR_DYNADOT_API_KEY. ' +
            'Set this in your .env file or registrar config file.',
          'dynadot',
          'REGISTRAR_CONFIG_ERROR',
          { missing: 'apiKey' },
        );
      }
      return new DynadotRegistrarProvider(apiKey);
    },
  };

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    const checkedAt = new Date().toISOString();
    const results: RegistrarPriceCheck[] = [];

    for (const domain of domains) {
      try {
        const url = `${DYNADOT_API_BASE}?key=${this.#apiKey}&command=search&domain0=${encodeURIComponent(domain)}&show_registration_price=1&show_renewal_price=1&show_transfer_price=1`;
        const response = await fetch(url);
        const json = (await response.json()) as DynadotApiResponse;

        if (json.status !== 'success') {
          results.push({
            domain,
            available: false,
            registerPriceEur: null,
            renewalPriceEur: null,
            transferPriceEur: null,
            checkedAt,
          });
          continue;
        }

        const entry = json['domain-search']?.[0];
        const available = entry?.['is-available'] ?? false;
        results.push({
          domain,
          available,
          registerPriceEur: available ? (entry?.['register-price'] ?? null) : null,
          renewalPriceEur: entry?.['renew-price'] ?? null,
          transferPriceEur: entry?.['transfer-price'] ?? null,
          checkedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ domain, error: msg }, 'Dynadot price check failed');
        results.push({
          domain,
          available: false,
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
    try {
      const url = `${DYNADOT_API_BASE}?key=${this.#apiKey}&command=register&domain0=${encodeURIComponent(request.domain)}&years=${request.years}`;
      const response = await fetch(url);
      const json = (await response.json()) as DynadotApiResponse;

      if (json.status !== 'success') {
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: json.error_message ?? 'Dynadot registration failed',
        };
      }

      const entry = json['domain-register']?.[0];
      const priceEur = entry?.price ?? (request.expectedPriceEur ?? 0) * request.years;

      return {
        domain: request.domain,
        success: true,
        orderId: entry?.['order-id'],
        priceEur,
        renewalPriceEur: 0,
        activeAt: new Date().toISOString(),
        message: 'Domain registered via Dynadot API',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ domain: request.domain, error: msg }, 'Dynadot purchase failed');
      return {
        domain: request.domain,
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: msg,
      };
    }
  }

  async listDomains(): Promise<RegistrarDomainInfo[]> {
    try {
      const url = `${DYNADOT_API_BASE}?key=${this.#apiKey}&command=domain-list`;
      const response = await fetch(url);
      const json = (await response.json()) as DynadotApiResponse;

      if (json.status !== 'success') {
        return [];
      }

      return (json['domain-info'] ?? []).map((d) => ({
        domain: d['domain-name'],
        registrar: 'dynadot',
        expiryDate: d['expire-date'],
        autoRenew: d['auto-renew'],
        locked: d['lock-status'],
        nameServers: d['name-servers'] ?? [],
      }));
    } catch (err) {
      logger.error({ err }, 'Dynadot listDomains failed');
      return [];
    }
  }

  async getRenewalCost(domain: string): Promise<number> {
    const checks = await this.checkPrice([domain]);
    return checks[0]?.renewalPriceEur ?? 0;
  }
}
