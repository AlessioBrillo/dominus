// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Namecheap Registrar provider (ADR-0086, M8b).
 *
 * UNVERIFIED (ADR-0082): this adapter has not been exercised against the
 * real Namecheap API. It ships behind the RegistrarProvider interface so it
 * can be enabled once the operator has verified API access.
 *
 * Namecheap API documentation: https://www.namecheap.com/support/api/
 * Base URL: https://api.namecheap.com/xml.response
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

const NAMECHEAP_API_BASE = 'https://api.namecheap.com/xml.response';

interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  userName: string;
  clientIp: string;
}

export class NamecheapRegistrarProvider implements RegistrarProvider {
  readonly name = 'namecheap';

  readonly #config: NamecheapConfig;

  constructor(apiUser: string, apiKey: string, userName: string, clientIp: string) {
    this.#config = { apiUser, apiKey, userName, clientIp };
  }

  static readonly registration: RegistrarRegistration = {
    name: 'namecheap',
    displayName: 'Namecheap',
    descriptor: {
      name: 'namecheap',
      displayName: 'Namecheap',
      description:
        'Namecheap domain registration via API. Requires API user, API key, username, and client IP (IP must be whitelisted in Namecheap). UNVERIFIED against the real Namecheap API (ADR-0082) — enable only after verifying credentials.',
      website: 'https://www.namecheap.com/',
      docsUrl: 'https://www.namecheap.com/support/api/',
      configFields: [
        {
          key: 'apiUser',
          label: 'API User',
          type: 'string',
          required: true,
          description: 'Namecheap API user',
          placeholder: 'REGISTRAR_NAMECHEAP_API_USER',
        },
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          description: 'Namecheap API key',
          placeholder: 'REGISTRAR_NAMECHEAP_API_KEY',
        },
        {
          key: 'userName',
          label: 'Username',
          type: 'string',
          required: true,
          description: 'Namecheap username',
          placeholder: 'REGISTRAR_NAMECHEAP_USERNAME',
        },
        {
          key: 'clientIp',
          label: 'Client IP',
          type: 'string',
          required: true,
          description: 'Client IP address (whitelisted in Namecheap)',
          placeholder: 'REGISTRAR_NAMECHEAP_CLIENT_IP',
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
      features: ['Domain registration via API', 'Domain renewal via API', 'Domain list via API'],
    },
    create: (config: Record<string, string>) => {
      const apiUser = config.apiUser ?? '';
      const apiKey = config.apiKey ?? '';
      const userName = config.userName ?? '';
      const clientIp = config.clientIp ?? '';
      if (!apiUser || !apiKey || !userName || !clientIp) {
        throw new ProviderError(
          'Namecheap Registrar requires REGISTRAR_NAMECHEAP_API_USER, REGISTRAR_NAMECHEAP_API_KEY, REGISTRAR_NAMECHEAP_USERNAME and REGISTRAR_NAMECHEAP_CLIENT_IP.',
          'namecheap',
          'REGISTRAR_CONFIG_ERROR',
          {
            missing: !apiUser
              ? 'apiUser'
              : !apiKey
                ? 'apiKey'
                : !userName
                  ? 'userName'
                  : 'clientIp',
          },
        );
      }
      return new NamecheapRegistrarProvider(apiUser, apiKey, userName, clientIp);
    },
  };

  async checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]> {
    const checkedAt = new Date().toISOString();
    const results: RegistrarPriceCheck[] = [];

    for (const domain of domains) {
      try {
        const params = new URLSearchParams({
          ApiUser: this.#config.apiUser,
          ApiKey: this.#config.apiKey,
          UserName: this.#config.userName,
          ClientIp: this.#config.clientIp,
          Command: 'namecheap.domains.check',
          DomainList: domain,
        });
        const response = await fetch(`${NAMECHEAP_API_BASE}?${params}`);
        const xml = await response.text();

        const available = /<Domain Available="true"/.test(xml);
        const priceMatch = xml.match(/<Price Currency="USD"[^>]*>([\d.]+)</);
        const price = priceMatch && priceMatch[1] ? parseFloat(priceMatch[1]) : null;

        results.push({
          domain,
          available,
          registerPriceEur: available ? (price ?? null) : null,
          renewalPriceEur: price ?? null,
          transferPriceEur: null,
          checkedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ domain, error: msg }, 'Namecheap price check failed');
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
      const params = new URLSearchParams({
        ApiUser: this.#config.apiUser,
        ApiKey: this.#config.apiKey,
        UserName: this.#config.userName,
        ClientIp: this.#config.clientIp,
        Command: 'namecheap.domains.create',
        DomainName: request.domain,
        Years: String(request.years),
      });
      const response = await fetch(`${NAMECHEAP_API_BASE}?${params}`);
      const xml = await response.text();

      const success = xml.includes('<Response') && !xml.includes('<Error');
      if (!success) {
        return {
          domain: request.domain,
          success: false,
          priceEur: 0,
          renewalPriceEur: 0,
          error: 'Namecheap registration failed',
        };
      }

      const priceEur = (request.expectedPriceEur ?? 0) * request.years;

      return {
        domain: request.domain,
        success: true,
        priceEur,
        renewalPriceEur: 0,
        activeAt: new Date().toISOString(),
        message: 'Domain registered via Namecheap API',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ domain: request.domain, error: msg }, 'Namecheap purchase failed');
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
      const params = new URLSearchParams({
        ApiUser: this.#config.apiUser,
        ApiKey: this.#config.apiKey,
        UserName: this.#config.userName,
        ClientIp: this.#config.clientIp,
        Command: 'namecheap.domains.list',
      });
      const response = await fetch(`${NAMECHEAP_API_BASE}?${params}`);
      const xml = await response.text();

      const domains: RegistrarDomainInfo[] = [];
      const domainMatches = xml.matchAll(/<Domain Name="([^"]+)"[^>]*>([\s\S]*?)<\/Domain>/g);
      for (const match of domainMatches) {
        domains.push({
          domain: match[1] ?? '',
          registrar: 'namecheap',
          expiryDate: '',
          autoRenew: false,
          locked: false,
          nameServers: [],
        });
      }
      return domains;
    } catch (err) {
      logger.error({ err }, 'Namecheap listDomains failed');
      return [];
    }
  }

  async getRenewalCost(domain: string): Promise<number> {
    const checks = await this.checkPrice([domain]);
    return checks[0]?.renewalPriceEur ?? 0;
  }
}
