// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

export interface ApiKeySummary {
  id: number;
  name: string;
  /** First characters of the key, enough to recognise it. The secret is never listed. */
  prefix: string;
  role: 'admin' | 'member';
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  id: number;
  name: string;
  prefix: string;
  /** The full secret. Returned exactly once. */
  key: string;
  message: string;
}

export function fetchApiKeys(signal?: AbortSignal): Promise<ApiKeySummary[]> {
  return api.get<ApiKeySummary[]>('/keys', signal);
}

export function createApiKey(name: string, role: 'admin' | 'member'): Promise<CreatedApiKey> {
  return api.post<CreatedApiKey>('/keys', { name, role });
}

export async function revokeApiKey(id: number): Promise<void> {
  await api.delete(`/keys/${id}`);
}
