import { DominusError } from './errors.js';

export class PurchaseError extends DominusError {
  readonly domain: string;
  readonly provider: string;
  constructor(domain: string, provider: string, message: string, code = 'PURCHASE_ERROR') {
    super(message, code);
    this.name = 'PurchaseError';
    this.domain = domain;
    this.provider = provider;
  }
}

export class PurchaseNotApprovedError extends PurchaseError {
  constructor(domain: string, provider: string) {
    super(domain, provider, 'Purchase not operator-approved', 'PURCHASE_NOT_APPROVED');
    this.name = 'PurchaseNotApprovedError';
  }
}

export class RegistrarConfigError extends DominusError {
  readonly registrar: string;
  constructor(registrar: string, message: string) {
    super(`[${registrar}] ${message}`, 'REGISTRAR_CONFIG_ERROR');
    this.name = 'RegistrarConfigError';
    this.registrar = registrar;
  }
}

export interface PurchaseRecord {
  domain: string;
  registrar: string;
  priceEur: number;
  renewalPriceEur: number;
  purchasedAt: string;
  orderId?: string | undefined;
  portfolioEntryId?: number | undefined;
  outcomeId?: number | undefined;
}

export interface RegistrarConfigField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number';
  required: boolean;
  description: string;
  placeholder?: string;
}

export interface RegistrarDescriptor {
  name: string;
  displayName: string;
  description: string;
  website: string;
  docsUrl: string;
  configFields: RegistrarConfigField[];
  supportedTlds: string[];
  features: string[];
}

export enum PurchaseApprovalMode {
  AlwaysConfirm = 'always_confirm',
  AutoApprove = 'auto_approve',
}
