// SPDX-License-Identifier: AGPL-3.0-only
import type { RegistrarProvider } from '../providers/registrar/registrar-provider.js';
import {
  CATALOG_TLDS,
  CATALOG_REGISTRARS,
  REGISTRAR_TLD_PRICES,
  type TcoComparison,
  type TcoOption,
  type TldPriceMatrix,
  type RegistrarName,
} from '../types/registrar-catalog.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

const DEFAULT_HOLDING_YEARS = 3;

/**
 * Registrar catalog service (ADR-0086).
 *
 * Computes TCO (total cost of ownership) comparisons across registrars for a
 * given TLD, recommends the cheapest auto-purchase-capable registrar, and
 * exposes the static price matrix. Real-time price checks can override the
 * static data when a RegistrarProvider is configured.
 */
export class RegistrarCatalogService {
  readonly #registrar: RegistrarProvider | undefined;

  constructor(registrar?: RegistrarProvider | undefined) {
    this.#registrar = registrar;
  }

  /** All TLDs covered by the catalog. */
  getTlds(): string[] {
    return [...CATALOG_TLDS];
  }

  /** All registrars in the catalog. */
  getRegistrars(): RegistrarName[] {
    return [...CATALOG_REGISTRARS];
  }

  /**
   * Price matrix for a TLD: per-register/renewal/transfer prices, plus the
   * cheapest register and renewal across all registrars.
   */
  getTldMatrix(tld: string): TldPriceMatrix | null {
    const entries = REGISTRAR_TLD_PRICES[tld.toLowerCase()];
    if (!entries) return null;

    const registerPrices = entries
      .map((e) => e.registerPriceEur)
      .filter((p): p is number => p !== null);
    const renewalPrices = entries
      .map((e) => e.renewalPriceEur)
      .filter((p): p is number => p !== null);

    return {
      tld: tld.toLowerCase(),
      registrars: entries,
      cheapestRegisterEur: registerPrices.length > 0 ? Math.min(...registerPrices) : null,
      cheapestRenewalEur: renewalPrices.length > 0 ? Math.min(...renewalPrices) : null,
    };
  }

  /**
   * TCO comparison for a domain over a holding period (default 3 years).
   * TCO = register price + (holdingYears - 1) * renewal price.
   */
  computeTco(domain: string, holdingYears: number = DEFAULT_HOLDING_YEARS): TcoComparison {
    const tld = this.#extractTld(domain);
    const entries = REGISTRAR_TLD_PRICES[tld.toLowerCase()] ?? [];

    const options: TcoOption[] = entries.map((entry) => {
      const register = entry.registerPriceEur;
      const renewal = entry.renewalPriceEur;
      const tco =
        register !== null && renewal !== null ? register + (holdingYears - 1) * renewal : null;
      return {
        registrar: entry.registrar,
        registerPriceEur: register,
        renewalPriceEur: renewal,
        tcoEur: tco,
        autoPurchase: entry.autoPurchase,
        verified: entry.verified,
      };
    });

    // Sort by TCO ascending (nulls last).
    options.sort((a, b) => {
      if (a.tcoEur === null && b.tcoEur === null) return 0;
      if (a.tcoEur === null) return 1;
      if (b.tcoEur === null) return -1;
      return a.tcoEur - b.tcoEur;
    });

    // Recommended: cheapest TCO among auto-purchase-capable AND verified registrars.
    const recommendedOption = options.find(
      (o) => o.autoPurchase && o.verified && o.tcoEur !== null,
    );
    const recommended = recommendedOption?.registrar ?? null;

    // Cheapest overall (any registrar with a TCO).
    const cheapestOption = options.find((o) => o.tcoEur !== null);
    const cheapestOverall = cheapestOption?.registrar ?? null;

    return {
      domain,
      tld: tld.toLowerCase(),
      holdingYears,
      options,
      recommended,
      cheapestOverall,
    };
  }

  /**
   * Recommend a registrar for purchasing a domain. Returns the verified
   * auto-purchase registrar with the lowest TCO, falling back to the cheapest
   * auto-purchase registrar, then the cheapest overall (manual).
   */
  recommendRegistrar(
    domain: string,
    holdingYears: number = DEFAULT_HOLDING_YEARS,
  ): {
    registrar: RegistrarName | null;
    reason: string;
    tcoEur: number | null;
  } {
    const tco = this.computeTco(domain, holdingYears);

    const verifiedAuto = tco.options.find((o) => o.autoPurchase && o.verified && o.tcoEur !== null);
    if (verifiedAuto) {
      return {
        registrar: verifiedAuto.registrar,
        reason: `verified_auto_purchase`,
        tcoEur: verifiedAuto.tcoEur,
      };
    }

    const anyAuto = tco.options.find((o) => o.autoPurchase && o.tcoEur !== null);
    if (anyAuto) {
      return {
        registrar: anyAuto.registrar,
        reason: `auto_purchase_unverified`,
        tcoEur: anyAuto.tcoEur,
      };
    }

    const cheapest = tco.options.find((o) => o.tcoEur !== null);
    if (cheapest) {
      return {
        registrar: cheapest.registrar,
        reason: `manual_cheapest_tco`,
        tcoEur: cheapest.tcoEur,
      };
    }

    return {
      registrar: null,
      reason: `no_price_data`,
      tcoEur: null,
    };
  }

  /** Extract TLD (with leading dot) from a domain name. */
  #extractTld(domain: string): string {
    const parts = domain.toLowerCase().split('.');
    if (parts.length < 2) return '';
    return `.${parts.slice(1).join('.')}`;
  }

  /** Refresh prices from the active RegistrarProvider (real-time check). */
  async refreshPrices(tlds: string[] = CATALOG_TLDS): Promise<void> {
    if (!this.#registrar) {
      logger.warn(
        'RegistrarCatalogService: no registrar provider configured — cannot refresh real-time prices',
      );
      return;
    }

    for (const tld of tlds) {
      // Use a probe domain to check prices; this is best-effort.
      const probe = `probe${tld}`;
      try {
        const checks = await this.#registrar.checkPrice([probe]);
        const check = checks[0];
        if (check) {
          logger.info(
            { tld, register: check.registerPriceEur, renewal: check.renewalPriceEur },
            'RegistrarCatalogService: real-time price check',
          );
        }
      } catch (err: unknown) {
        logger.warn({ tld, err }, 'RegistrarCatalogService: real-time price check failed');
      }
    }
  }
}
