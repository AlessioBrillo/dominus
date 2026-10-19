// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export type CredentialProviderType = 'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace';

export interface TenantCredentialView {
  providerType: CredentialProviderType;
  providerName: string;
  accountId: string | null;
  credentialScope: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetCredentialRequest {
  secret: string;
  accountId?: string | null;
  credentialScope?: string | null;
}

export function listTenantCredentials(): Promise<{
  credentials: TenantCredentialView[];
}> {
  return api.get<{ credentials: TenantCredentialView[] }>('/tenant/credentials');
}

export function setTenantCredential(
  providerType: CredentialProviderType,
  providerName: string,
  input: SetCredentialRequest,
): Promise<{
  ok: boolean;
  providerType: CredentialProviderType;
  providerName: string;
  message: string;
}> {
  return api.put(`/tenant/credentials/${providerType}/${providerName}`, input);
}

export function deleteTenantCredential(
  providerType: CredentialProviderType,
  providerName: string,
): Promise<{ ok: boolean; deleted: boolean }> {
  return api.delete(`/tenant/credentials/${providerType}/${providerName}`);
}
