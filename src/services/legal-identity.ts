// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The operator identity: reading it from the configuration, and deciding
 * whether it is complete.
 *
 * This lives apart from the document text (legal-content.ts) on purpose: the
 * placeholder detector must not sit in the same file as the published text,
 * because a guardrail that scans a file containing its own detection strings
 * either cries wolf or gets weakened. The text file is scanned for
 * placeholders; this file is the detector.
 */

export interface LegalIdentity {
  /** Registered name of the operator (individual or company). */
  entityName: string;
  /** 'individual' (sole trader) or 'company'. */
  entityKind: 'individual' | 'company';
  /** Registered address, as it must appear on the legal notice. */
  registeredAddress: string;
  /** VAT identification number (Partita IVA). */
  vatId: string;
  /** Business register number (REA), companies only. */
  reaNumber: string;
  /** Certified electronic address (PEC), companies only. */
  pec: string;
  /** General contact address. */
  contactEmail: string;
  /** Address for data-subject requests. */
  privacyEmail: string;
  /** Supervisory authority for data protection. */
  supervisoryAuthority: string;
}

/** The identity fields the operator must publish, in the order they appear. */
export const REQUIRED_IDENTITY_FIELDS = [
  'entityName',
  'registeredAddress',
  'vatId',
  'contactEmail',
  'privacyEmail',
] as const;

/**
 * The identity of the operator, read from the configuration.
 *
 * Kept next to the documents so that the launch gate and the legal endpoint
 * agree on what "the operator identity" means.
 */
export function identityFromConfig(config: {
  LEGAL_ENTITY_NAME?: string | undefined;
  LEGAL_ENTITY_KIND?: 'individual' | 'company' | undefined;
  LEGAL_REGISTERED_ADDRESS?: string | undefined;
  LEGAL_VAT_ID?: string | undefined;
  LEGAL_REA_NUMBER?: string | undefined;
  LEGAL_PEC?: string | undefined;
  LEGAL_CONTACT_EMAIL?: string | undefined;
  LEGAL_PRIVACY_EMAIL?: string | undefined;
  LEGAL_SUPERVISORY_AUTHORITY?: string | undefined;
}): LegalIdentity {
  return {
    entityName: config.LEGAL_ENTITY_NAME ?? '',
    entityKind: config.LEGAL_ENTITY_KIND ?? 'individual',
    registeredAddress: config.LEGAL_REGISTERED_ADDRESS ?? '',
    vatId: config.LEGAL_VAT_ID ?? '',
    reaNumber: config.LEGAL_REA_NUMBER ?? '',
    pec: config.LEGAL_PEC ?? '',
    contactEmail: config.LEGAL_CONTACT_EMAIL ?? '',
    privacyEmail: config.LEGAL_PRIVACY_EMAIL ?? '',
    supervisoryAuthority: config.LEGAL_SUPERVISORY_AUTHORITY ?? '',
  };
}

/**
 * The identity fields that are missing or still hold a placeholder.
 *
 * Used by the launch gate (npm run launch:check): a deployment that sells
 * subscriptions without a published identity is not launchable, and a
 * placeholder that slipped into the shipped pages is worse than no page at
 * all — it looks compliant without being so.
 */
export function missingIdentityFields(identity: LegalIdentity): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_IDENTITY_FIELDS) {
    const value = identity[field] ?? '';
    if (value.trim() === '' || isPlaceholderValue(value)) missing.push(field);
  }
  return missing;
}

/** True when a value is one of the placeholders that must never be published. */
export function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return true;
  return (
    normalized.includes('.example') ||
    normalized.includes('example.com') ||
    normalized.includes('example.org') ||
    normalized.includes('changeme') ||
    normalized.includes('change_me') ||
    normalized.includes('change-me') ||
    normalized.includes('tbd') ||
    normalized.includes('todo') ||
    normalized.includes('placeholder') ||
    normalized.includes('xxx')
  );
}
