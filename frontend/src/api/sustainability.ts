// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export type CarryCostVerdict = 'sustainable' | 'marginal' | 'loss' | 'insufficient_data';

export interface CarryCostResult {
  domain: string;
  verdict: CarryCostVerdict;
  annualRevenueEur: number;
  annualCarryCostEur: number;
  netAnnualEur: number;
  reason: string;
}

export function getSustainability(): Promise<{ verdicts: CarryCostResult[] }> {
  return api.get<{ verdicts: CarryCostResult[] }>('/sustainability');
}
