// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Porkbun Registrar provider (ADR-0086, M8b).
 *
 * UNVERIFIED (ADR-0082): this adapter has not been exercised against the
 * real Porkbun API. It ships behind the RegistrarProvider interface so it
 * can be enabled once the operator has verified API access.
 *
 * Porkbun API documentation: https://porkbun.com/api/json/v3/documentation
 * Base URL: https://porkbun.com/api/json/v3/
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

const PORKBUN_API_BASE = 'https://porkbun.com/api/json/v3';

interface PorkbunApiResponse {
  status: string;
  message?: string;
  domainResults?: Array<{
    domain: string;
    available: boolean;
    price: number;
    renewal: number;
    transfer: number;
  }>;
  orderResults?: Array<{
    domain: string;
    status: string;
    orderId: string;
    amount: number;
  }>;
  domainList?: Array<{
    domain: string;
    expiry: string;
    autoRenew: boolean;
    locked: boolean;
    nameServers: string[];
  }>;
}

export class PorkbunRegistrarProvider implements RegistrarProvider {
  readonly name = 'porkbun';

  readonly #apiKey: string;
  readonly #secretKey: string;

  constructor(apiKey: string, secretKey: string) {
    this.#apiKey = apiKey;
    this.#secretKey = secretKey;
  }

  static readonly registration: RegistrarRegistration = {
    name: 'porkbun',
    displayName: 'Porkbun',
    descriptor: {
      name: 'porkbun',
      displayName: 'Porkbun',
      description:
        'Porkbun domain registration via JSON API v3. Requires API key and secret key from your Porkbun account. UNVERIFIED against the real Porkbun API (ADR-0082) — enable only after verifying credentials.',
      website: 'https://porkbun.com/',
      docsUrl: 'https://porkbun.com/api/json/v3/documentation',
      configFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Porkbun API key',
          placeholder: 'REGISTRAR_PORKBUN_API_KEY',
        },
        {
          key: 'secretKey',
          label: 'Secret Key',
          type: 'password',
          required: true,
          description: 'Porkbun secret key',
          placeholder: 'REGISTRAR_PORKBUN_SECRET_KEY',
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
        'WHOIS privacy (free)',
      ],
    },
    create: (config: Record<string, string>) => {
      const apiKey = config.apiKey;
      const secretKey = config.secretKey;
      if (!apiKey || !secretKey) {
        throw new ProviderError(
          'Porkbun Registrar requires both REGISTRAR_PORKBUN_API_KEY and REGISTRAR_PORKBUN_SECRET_KEY.',
          'porkbun',
          'REGISTRAR_CONFIG_ERROR',
          { missing: apiKey ? 'secretKey' : 'apiKey' },
        );
      }
      return new PorkbunRegistrarProvider(apiKey, secretKey);
    },
  };

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    const checkedAt = new Date().toISOString();
    const results: RegistrarPriceCheck[] = [];

    for (const domain of domains) {
      try {
        const url = `${PORKBUN_API_BASE}/domains/check`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apikey: this.#apiKey,
            secretapikey: this.#secretKey,
            domain: domain,
          }),
        });
        const json = (await response.json()) as PorkbunApiResponse;

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

        const entry = json.domainResults?.[0];
        const available = entry?.available ?? false;
        results.push({
          domain,
          available,
          registerPriceEur: available ? (entry?.price ?? null) : null,
          renewalPriceEur: entry?.renewal ?? null,
          transferPriceEur: entry?.transfer ?? null,
          checkedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ domain, error: msg }, 'Porkbun price check failed');
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
      const url = `${PORKBUN_API_BASE}/domains/register`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apikey: this.#apiKey,
          secretapikey: this.#secretKey,
          domain: request.domain,
          years: request.years,
        }),
      });
      const json = (await response.json()) as PorkbunApiResponse;

      if (json.status !== 'success') {
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: json.message ?? 'Porkbun registration failed',
        };
      }

      const entry = json.orderResults?.[0];
      const priceEur = entry?.amount ?? (request.expectedPriceEur ?? 0) * request.years;

      return {
        domain: request.domain,
        success: true,
        orderId: entry?.orderId,
        priceEur,
        renewalPriceEur: 0,
        activeAt: new Date().toISOString(),
        message: 'Domain registered via Porkbun API',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ domain: request.domain, error: msg }, 'Porkbun purchase failed');
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
      const url = `${PORKBUN_API_BASE}/domains/listAll`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apikey: this.#apiKey,
          secretapikey: this.#secretKey,
        }),
      });
      const json = (await response.json()) as PorkbunApiResponse;

      if (json.status !== 'success') return [];

      return (json.domainList ?? []).map((d) => ({
        domain: d.domain,
        registrar: 'porkbun',
        expiryDate: d.expiry,
        autoRenew: d.autoRenew,
        locked: d.locked,
        nameServers: d.nameServers ?? [],
      }));
    } catch (err) {
      logger.error({ err }, 'Porkbun listDomains failed');
      return [];
    }
  }

  async getRenewalCost(domain: string): Promise<number> {
    const checks = await this.checkPrice([domain]);
    return checks[0]?.renewalPriceEur ?? 0;
  }
}
