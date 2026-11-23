// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

export type ContractPurpose = 'signup' | 'checkout' | 'dpa' | 'art1341';
export type ContractDocumentSlug = 'terms' | 'privacy' | 'dpa';

export interface AcceptanceRequest {
  email: string;
  tenantId?: string;
  purpose: ContractPurpose;
  documentSlug: ContractDocumentSlug;
  documentVersion: string;
  contentHash: string;
  checkoutSessionId?: string;
  /** Italian SDI destination code or PEC, for a business customer's invoice. */
  billingCode?: string;
}

/** Append a contract acceptance to the first-party ledger. */
export async function recordAcceptance(input: AcceptanceRequest): Promise<void> {
  await api.post('/contracts/accept', input);
}
