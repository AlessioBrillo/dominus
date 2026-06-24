import { api } from './client.js';
import type { PortfolioEntry } from '../types/domain.js';

export interface PortfolioListResponse {
  portfolio: PortfolioEntry[];
}

export function fetchPortfolio(): Promise<PortfolioListResponse> {
  return api.get<PortfolioListResponse>('/portfolio');
}

export interface RescoreResponse {
  totalDurationMs: number;
  results: Array<{
    domain: string;
    calibratedScore: number;
    suggestedListPrice: number;
    expectedValue: number;
    confidence: number;
    trademarkClear: boolean;
    trademarkVerdict: string;
    error?: string;
  }>;
}

export function rescorePortfolio(): Promise<RescoreResponse> {
  return api.post<RescoreResponse>('/portfolio/rescore');
}

export function refreshVerdicts(): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/portfolio/verdicts');
}

export interface UpdateVerdictInput {
  verdict: 'keep' | 'drop' | 'reprice';
  notes?: string;
}

export function updateVerdict(domain: string, input: UpdateVerdictInput): Promise<{ ok: boolean }> {
  return api.patch<{ ok: boolean }>(`/portfolio/${encodeURIComponent(domain)}/verdict`, input);
}

export function removeFromPortfolio(domain: string): Promise<void> {
  return api.delete<void>(`/portfolio/${encodeURIComponent(domain)}`);
}

export function updatePortfolioEntry(
  domain: string,
  input: { notes?: string; acquisitionCost?: number; renewalCost?: number },
): Promise<{ ok: boolean }> {
  return api.patch<{ ok: boolean }>(`/portfolio/${encodeURIComponent(domain)}`, input);
}
