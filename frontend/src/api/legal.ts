// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

export type LegalDocumentSlug = 'legal-notice' | 'terms' | 'privacy';

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
  entityKind: 'individual' | 'company';
  registeredAddress: string;
  vatId: string;
  reaNumber: string;
  pec: string;
  contactEmail: string;
  privacyEmail: string;
  supervisoryAuthority: string;
}

export interface LegalContent {
  mode: 'cloud' | 'community';
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
