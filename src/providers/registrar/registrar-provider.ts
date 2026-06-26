/**
 * RegistrarProvider abstracts the registrar layer so the portfolio manager
 * and operator workflow are decoupled from any specific domain registrar.
 *
 * The core DOMINUS workflow is decision-support only — the operator buys
 * and manages domains manually. This interface exists so that a future
 * automated workflow (purchase from pipeline recommendation, bulk renewal
 * checks, auto-push to marketplace) can be implemented as a provider swap
 * without touching portfolio logic.
 *
 * Current implementations:
 *  - ManualRegistrarProvider (default): every method returns "manual" —
 *    the operator handles registration, renewal, and DNS management outside
 *    DOMINUS. This is the safe default for the budget-constrained phase.
 *
 * See ADR-0004 for the provider abstraction pattern.
 */

export interface RegistrarPurchaseRequest {
  domain: string;
  years: number;
}

export interface RegistrarPurchaseResult {
  domain: string;
  success: boolean;
  orderId?: string | undefined;
  /** Purchase price charged in EUR. */
  priceEur: number;
  /** Renewal price per year in EUR. */
  renewalPriceEur: number;
  /** ISO-8601 date when the domain will be active. */
  activeAt?: string | undefined;
  /** Human-readable message from the registrar. */
  message?: string | undefined;
  error?: string | undefined;
}

export interface RegistrarPriceCheck {
  domain: string;
  /** Whether the domain is available for registration. */
  available: boolean;
  /** Registration price in EUR. null when unavailable. */
  registerPriceEur: number | null;
  /** Renewal price per year in EUR. null when unavailable. */
  renewalPriceEur: number | null;
  /** Transfer price in EUR. null when not applicable. */
  transferPriceEur: number | null;
  /** ISO-8601 timestamp of the price check. */
  checkedAt: string;
}

export interface RegistrarDomainInfo {
  domain: string;
  registrar: string;
  expiryDate: string;
  autoRenew: boolean;
  locked: boolean;
  nameServers: string[];
}

export interface RegistrarProvider {
  /** Check registration and renewal prices for one or more domains. */
  checkPrice(domains: string[]): Promise<RegistrarPriceCheck[]>;

  /** Purchase a domain. */
  purchase(request: RegistrarPurchaseRequest): Promise<RegistrarPurchaseResult>;

  /** List all domains managed through this registrar. */
  listDomains(): Promise<RegistrarDomainInfo[]>;

  /** Get the renewal price per year for a domain. */
  getRenewalCost(domain: string): Promise<number>;

  /** Get the human-readable name of this registrar. */
  readonly name: string;
}
