import { api } from './client';
import type { Outcome } from '@/types/domain';

export interface CreateOutcomeInput {
  domain: string;
  type: 'sold' | 'dropped' | 'expired' | 'renewed';
  occurredAt: string;
  salePriceEur?: number;
  listingPriceEur?: number;
  daysListed?: number;
  venue?: string;
  commissionPct?: number;
  notes?: string;
}

export async function createOutcome(input: CreateOutcomeInput): Promise<Outcome> {
  const { outcome } = await api.post<{ outcome: Outcome }>('/outcomes', input);
  return outcome;
}

export async function listOutcomes(type?: string): Promise<Outcome[]> {
  const params = type ? `?type=${type}` : '';
  const { outcomes } = await api.get<{ outcomes: Outcome[] }>(`/outcomes${params}`);
  return outcomes;
}
