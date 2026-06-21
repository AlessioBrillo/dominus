import { api } from './client.js';
import type { ScoreResult } from '../types/domain.js';

export interface SampleRunResult {
  domain: string;
  score: ScoreResult;
  trademark: {
    verdict: string;
    verifiedSources: string[];
  } | null;
}

export interface SampleRunResponse {
  results: SampleRunResult[];
  sampleCount: number;
}

export interface PortfolioImportDomain {
  domain: string;
  tld: string;
  acquiredAt: string;
  renewalDate: string;
  acquisitionCost: number;
  renewalCost: number;
  registrar?: string;
}

export interface ImportVerdict {
  domain: string;
  verdict: string;
  weightedScore: number;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  trademarkClear: boolean;
  renewalCost: number;
}

export interface PortfolioImportResponse {
  imported: number;
  errors?: Array<{ domain: string; error: string }>;
  verdicts: ImportVerdict[];
  summary: {
    keep: number;
    drop: number;
    reprice: number;
    annualSavingsEur: number;
  };
}

export interface OnboardingState {
  currentStep: string;
  stepData: Record<string, unknown> | null;
  completedAt: string | null;
}

export function runSample(): Promise<SampleRunResponse> {
  return api.post<SampleRunResponse>('/onboarding/sample-run');
}

export function importPortfolio(
  domains: PortfolioImportDomain[],
): Promise<PortfolioImportResponse> {
  return api.post<PortfolioImportResponse>('/onboarding/portfolio/import', { domains });
}

export function getOnboardingState(): Promise<OnboardingState> {
  return api.get<OnboardingState>('/onboarding/state');
}

export function updateOnboardingState(
  currentStep: string,
  stepData?: Record<string, unknown>,
): Promise<{ currentStep: string; saved: boolean }> {
  return api.patch<{ currentStep: string; saved: boolean }>('/onboarding/state', {
    currentStep,
    stepData,
  });
}
