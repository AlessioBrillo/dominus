import { api } from './client.js';
import type { ProviderStatus } from '../types/domain.js';

export interface ProvidersStatusResponse {
  providers: ProviderStatus[];
}

export async function fetchProviderStatuses(): Promise<ProviderStatus[]> {
  const data = await api.get<ProvidersStatusResponse>('/providers/status');
  return data.providers;
}
