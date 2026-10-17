// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Registrar catalog types (ADR-0086).
 *
 * Price matrix per TLD across registrars: registration price, renewal price,
 * transfer price. Used to recommend where to buy a domain and to compute
 * TCO (total cost of ownership) over a holding period. Data is static
 * (bundled list prices) — real-time price checks come from the active
 * RegistrarProvider when configured.
 */

export type RegistrarName =
  | 'cloudflare'
  | 'dynadot'
  | 'porkbun'
  | 'namecheap'
  | 'ovh'
  | 'namesilo'
  | 'gandi'
  | 'godaddy'
  | 'manual';

export interface RegistrarPriceEntry {
  /** Registrar key (matches RegistrarProvider.name). */
  registrar: RegistrarName;
  /** Human-readable display name. */
  displayName: string;
  /** Registration price in EUR for 1 year. Null when not offered. */
  registerPriceEur: number | null;
  /** Renewal price per year in EUR. Null when not offered. */
  renewalPriceEur: number | null;
  /** Transfer price in EUR. Null when not offered. */
  transferPriceEur: number | null;
  /** Whether the registrar supports automatic purchase via API. */
  autoPurchase: boolean;
  /** Whether the registrar is verified against the real API (ADR-0082). */
  verified: boolean;
  /** URL for manual purchase (deep link). */
  manualUrl?: string | undefined;
}

export interface TldPriceMatrix {
  tld: string;
  /** Prices per registrar for this TLD. */
  registrars: RegistrarPriceEntry[];
  /** Computed cheapest register price (across registrars). */
  cheapestRegisterEur: number | null;
  /** Computed cheapest renewal price (across registrars). */
  cheapestRenewalEur: number | null;
}

export interface TcoComparison {
  domain: string;
  tld: string;
  holdingYears: number;
  /** All registrar TCOs for this domain over the holding period. */
  options: TcoOption[];
  /** Recommended registrar (lowest TCO among auto-purchase capable). */
  recommended: RegistrarName | null;
  /** Cheapest registrar overall (may be manual only). */
  cheapestOverall: RegistrarName | null;
}

export interface TcoOption {
  registrar: RegistrarName;
  registerPriceEur: number | null;
  renewalPriceEur: number | null;
  /** Total cost over holdingYears: register + (holdingYears-1) * renewal. */
  tcoEur: number | null;
  autoPurchase: boolean;
  verified: boolean;
}

/** Static bundled price matrix (list prices, EUR). Updated manually. */
export const REGISTRAR_TLD_PRICES: Record<string, RegistrarPriceEntry[]> = {
  '.com': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 9.15,
      renewalPriceEur: 9.15,
      transferPriceEur: 9.15,
      autoPurchase: true,
      verified: true,
      manualUrl: 'https://dash.cloudflare.com/',
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 8.99,
      renewalPriceEur: 11.99,
      transferPriceEur: 8.99,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://www.dynadot.com/',
    },
    {
      registrar: 'porkbun',
      displayName: 'Porkbun',
      registerPriceEur: 10.48,
      renewalPriceEur: 10.48,
      transferPriceEur: 10.48,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://porkbun.com/',
    },
    {
      registrar: 'namecheap',
      displayName: 'Namecheap',
      registerPriceEur: 6.98,
      renewalPriceEur: 14.58,
      transferPriceEur: 9.98,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://www.namecheap.com/',
    },
    {
      registrar: 'ovh',
      displayName: 'OVHcloud',
      registerPriceEur: 8.99,
      renewalPriceEur: 11.99,
      transferPriceEur: 8.99,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://www.ovh.com/',
    },
    {
      registrar: 'namesilo',
      displayName: 'NameSilo',
      registerPriceEur: 9.99,
      renewalPriceEur: 10.99,
      transferPriceEur: 9.99,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://www.namesilo.com/',
    },
    {
      registrar: 'gandi',
      displayName: 'Gandi',
      registerPriceEur: 11.64,
      renewalPriceEur: 17.47,
      transferPriceEur: 11.64,
      autoPurchase: true,
      verified: false,
      manualUrl: 'https://gandi.net/',
    },
    {
      registrar: 'godaddy',
      displayName: 'GoDaddy',
      registerPriceEur: 1.99,
      renewalPriceEur: 19.99,
      transferPriceEur: 11.99,
      autoPurchase: false,
      verified: false,
      manualUrl: 'https://www.godaddy.com/',
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.it': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 10.0,
      renewalPriceEur: 10.0,
      transferPriceEur: 0.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'ovh',
      displayName: 'OVHcloud',
      registerPriceEur: 6.99,
      renewalPriceEur: 9.99,
      transferPriceEur: 0.0,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 9.99,
      renewalPriceEur: 12.99,
      transferPriceEur: 9.99,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.eu': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 8.0,
      renewalPriceEur: 8.0,
      transferPriceEur: 0.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'ovh',
      displayName: 'OVHcloud',
      registerPriceEur: 5.99,
      renewalPriceEur: 8.99,
      transferPriceEur: 0.0,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.net': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 11.0,
      renewalPriceEur: 11.0,
      transferPriceEur: 11.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 12.99,
      renewalPriceEur: 14.99,
      transferPriceEur: 11.99,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'porkbun',
      displayName: 'Porkbun',
      registerPriceEur: 11.78,
      renewalPriceEur: 11.78,
      transferPriceEur: 11.78,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.org': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 10.0,
      renewalPriceEur: 10.0,
      transferPriceEur: 10.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 10.99,
      renewalPriceEur: 13.99,
      transferPriceEur: 9.99,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.io': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 50.0,
      renewalPriceEur: 50.0,
      transferPriceEur: 50.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'porkbun',
      displayName: 'Porkbun',
      registerPriceEur: 36.0,
      renewalPriceEur: 36.0,
      transferPriceEur: 36.0,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 38.99,
      renewalPriceEur: 44.99,
      transferPriceEur: 38.99,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.co': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 30.0,
      renewalPriceEur: 30.0,
      transferPriceEur: 30.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'porkbun',
      displayName: 'Porkbun',
      registerPriceEur: 28.0,
      renewalPriceEur: 28.0,
      transferPriceEur: 28.0,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.shop': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 30.0,
      renewalPriceEur: 30.0,
      transferPriceEur: 30.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'dynadot',
      displayName: 'Dynadot',
      registerPriceEur: 34.99,
      renewalPriceEur: 39.99,
      transferPriceEur: 34.99,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.online': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 15.0,
      renewalPriceEur: 15.0,
      transferPriceEur: 15.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'porkbun',
      displayName: 'Porkbun',
      registerPriceEur: 12.48,
      renewalPriceEur: 12.48,
      transferPriceEur: 12.48,
      autoPurchase: true,
      verified: false,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
  '.site': [
    {
      registrar: 'cloudflare',
      displayName: 'Cloudflare Registrar',
      registerPriceEur: 20.0,
      renewalPriceEur: 20.0,
      transferPriceEur: 20.0,
      autoPurchase: true,
      verified: true,
    },
    {
      registrar: 'manual',
      displayName: 'Acquisto manuale',
      registerPriceEur: null,
      renewalPriceEur: null,
      transferPriceEur: null,
      autoPurchase: false,
      verified: true,
    },
  ],
};

/** All TLDs covered by the catalog. */
export const CATALOG_TLDS: string[] = Object.keys(REGISTRAR_TLD_PRICES);

/** All registrar names in the catalog. */
export const CATALOG_REGISTRARS: RegistrarName[] = [
  'cloudflare',
  'dynadot',
  'porkbun',
  'namecheap',
  'ovh',
  'namesilo',
  'gandi',
  'godaddy',
  'manual',
];
