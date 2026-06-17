import { api } from './client.js';

export interface PurchaseCheckResponse {
  check: {
    domain: string;
    available: boolean;
    registerPriceEur: number | null;
    renewalPriceEur: number | null;
    expectedValue: number | null;
    confidence: number | null;
    suggestedBuyMax: number | null;
    trademarkClear: boolean;
    operatorApprovalRequired: boolean;
  };
}

export interface PurchaseExecuteResponse {
  success: boolean;
  purchase?: {
    domain: string;
    registrar: string;
    priceEur: number;
    renewalPriceEur: number;
    purchasedAt: string;
    orderId?: string;
  };
  message?: string;
  error?: string;
}

export interface PriceCheckResponse {
  prices: Array<{
    domain: string;
    available: boolean;
    registerPriceEur: number | null;
    renewalPriceEur: number | null;
    checkedAt: string;
  }>;
}

export function preflightPurchase(domain: string): Promise<PurchaseCheckResponse> {
  return api.get<PurchaseCheckResponse>(`/purchase/preflight?domain=${encodeURIComponent(domain)}`);
}

export function executePurchase(
  domain: string,
  years: number = 1,
  operatorApproved: boolean = false,
): Promise<PurchaseExecuteResponse> {
  return api.post<PurchaseExecuteResponse>('/purchase/execute', {
    domain,
    years,
    operatorApproved,
  });
}

export function checkPrices(domains: string[]): Promise<PriceCheckResponse> {
  return api.get<PriceCheckResponse>(
    `/purchase/price?domains=${domains.map(encodeURIComponent).join(',')}`,
  );
}
