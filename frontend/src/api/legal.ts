// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

export type LegalDocumentSlug = 'legal-notice' | 'terms' | 'privacy';
export type LegalServiceStatus = 'community' | 'cloud_waitlist' | 'cloud_paid';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  slug: LegalDocumentSlug;
  title: string;
  scope: string;
  sections: LegalSection[];
}

export interface LegalIdentity {
  entityName: string;
  tradingName: string;
  entityKind: 'individual' | 'sole_trader' | 'company';
  legalForm: string;
  shareCapital: string;
  registeredAddress: string;
  vatId: string;
  reaNumber: string;
  registroImprese: string;
  pec: string;
  contactEmail: string;
  privacyEmail: string;
  supervisoryAuthority: string;
  vatRegime: 'ordinary' | 'forfettario' | 'none';
}

export interface LegalContent {
  mode: 'cloud' | 'community';
  status: LegalServiceStatus;
  version: string;
  /** SHA-256 of the published document bodies, stored with acceptance records. */
  contentHash: string;
  updatedAt: string;
  waitlistUrl?: string;
  /** True when the first-party waitlist can send confirmation emails. */
  waitlistAvailable: boolean;
  securityContactAvailable: boolean;
  sourceCodeUrl: string;
  identityPublished: boolean;
  identity: LegalIdentity;
  documents: LegalDocument[];
}

/**
 * The legal surface, served unauthenticated from the public namespace.
 *
 * The text lives on the server (src/services/legal-content.ts) because the
 * operator identity is configuration, and the same text must appear on the
 * server-rendered public pages and here.
 */
export function getLegalContent(): Promise<LegalContent> {
  return api.get<LegalContent>('/public/legal');
}
