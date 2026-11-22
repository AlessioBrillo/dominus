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
 *
 * Two identities exist, and conflating them was the defect this model closes:
 *
 * - an **individual** runs the project website and the community edition
 *   before a business exists. That person still has to name themselves as the
 *   data controller, but they have no VAT number, REA number or PEC yet;
 * - a **sole trader** or a **company** sells the managed service. Art. 7 of
 *   D.Lgs. 70/2003 and the VAT rules require the registration data, and a
 *   paid deployment must not boot without it.
 */

/** The legal form of the operator. */
export type LegalEntityKind = 'individual' | 'sole_trader' | 'company';

/** The VAT regime that applies to the operator. */
export type LegalVatRegime = 'ordinary' | 'forfettario' | 'none';

export interface LegalIdentity {
  /** Registered name of the operator (individual or company). */
  entityName: string;
  /** Commercial name the operator trades under, when it differs from the registered name. */
  tradingName: string;
  /** Natural person, registered sole trader, or registered company. */
  entityKind: LegalEntityKind;
  /**
   * The exact legal form, as it appears in the business register: "SRL",
   * "SRLS", "SPA", "SAS", "ditta individuale". Art. 7 of D.Lgs. 70/2003
   * requires the form to be disclosed; "company" alone is not the form.
   */
  legalForm: string;
  /**
   * Share capital, for the entities that have one. Art. 2250 c.c. and art. 7
   * of D.Lgs. 70/2003 require a company to publish it on its website.
   */
  shareCapital: string;
  /** Registered address, as it must appear on the legal notice. */
  registeredAddress: string;
  /** VAT identification number (Partita IVA). */
  vatId: string;
  /** Business register number (REA), business entities only. */
  reaNumber: string;
  /** Register office, for example "Registro Imprese di Roma". */
  registroImprese: string;
  /** Certified electronic address (PEC), business entities only. */
  pec: string;
  /** General contact address. */
  contactEmail: string;
  /** Address for data-subject requests. */
  privacyEmail: string;
  /** Supervisory authority for data protection. */
  supervisoryAuthority: string;
  /** VAT regime, used by the documents to describe prices correctly. */
  vatRegime: LegalVatRegime;
}

/**
 * The identity fields every deployment must publish, whatever its form.
 *
 * A natural person who runs a website is still a data controller: name,
 * address and a contact are not optional. The business-only fields are added
 * by `requiredIdentityFields()`.
 */
export const REQUIRED_IDENTITY_FIELDS = [
  'entityName',
  'registeredAddress',
  'contactEmail',
  'privacyEmail',
] as const;

/** The additional fields a registered business must publish. */
export const BUSINESS_IDENTITY_FIELDS = [
  'legalForm',
  'vatId',
  'registroImprese',
  'reaNumber',
  'pec',
] as const;

/** The additional field a company must publish (art. 2250 c.c.). */
export const COMPANY_IDENTITY_FIELDS = ['shareCapital'] as const;

/** True when the entity is a registered business that can sell a service. */
export function isBusinessEntity(kind: LegalEntityKind): boolean {
  return kind === 'sole_trader' || kind === 'company';
}

/**
 * The fields this identity must publish.
 *
 * `paidService` is the distinction that matters: a natural person may run a
 * free website and a waitlist, but a paid subscription needs an economic
 * operator that can issue an invoice. The paid gate therefore rejects
 * `individual` even when every free-text field is filled in.
 */
export function requiredIdentityFields(
  kind: LegalEntityKind,
  options: { paidService?: boolean } = {},
): readonly string[] {
  const fields: string[] = [...REQUIRED_IDENTITY_FIELDS];
  if (options.paidService === true) {
    if (!isBusinessEntity(kind)) fields.push('entityKind');
    fields.push(...BUSINESS_IDENTITY_FIELDS);
    if (kind === 'company') fields.push(...COMPANY_IDENTITY_FIELDS);
  } else if (isBusinessEntity(kind)) {
    fields.push(...BUSINESS_IDENTITY_FIELDS);
    if (kind === 'company') fields.push(...COMPANY_IDENTITY_FIELDS);
  }
  return fields;
}

/**
 * The identity of the operator, read from the configuration.
 *
 * Kept next to the documents so that the launch gate and the legal endpoint
 * agree on what "the operator identity" means.
 */
export function identityFromConfig(config: {
  LEGAL_ENTITY_NAME?: string | undefined;
  LEGAL_TRADING_NAME?: string | undefined;
  LEGAL_ENTITY_KIND?: LegalEntityKind | undefined;
  LEGAL_LEGAL_FORM?: string | undefined;
  LEGAL_SHARE_CAPITAL?: string | undefined;
  LEGAL_REGISTERED_ADDRESS?: string | undefined;
  LEGAL_VAT_ID?: string | undefined;
  LEGAL_REA_NUMBER?: string | undefined;
  LEGAL_REGISTRO_IMPRESE?: string | undefined;
  LEGAL_PEC?: string | undefined;
  LEGAL_CONTACT_EMAIL?: string | undefined;
  LEGAL_PRIVACY_EMAIL?: string | undefined;
  LEGAL_SUPERVISORY_AUTHORITY?: string | undefined;
  LEGAL_VAT_REGIME?: LegalVatRegime | undefined;
}): LegalIdentity {
  return {
    entityName: config.LEGAL_ENTITY_NAME ?? '',
    tradingName: config.LEGAL_TRADING_NAME ?? '',
    entityKind: config.LEGAL_ENTITY_KIND ?? 'individual',
    legalForm: config.LEGAL_LEGAL_FORM ?? '',
    shareCapital: config.LEGAL_SHARE_CAPITAL ?? '',
    registeredAddress: config.LEGAL_REGISTERED_ADDRESS ?? '',
    vatId: config.LEGAL_VAT_ID ?? '',
    reaNumber: config.LEGAL_REA_NUMBER ?? '',
    registroImprese: config.LEGAL_REGISTRO_IMPRESE ?? '',
    pec: config.LEGAL_PEC ?? '',
    contactEmail: config.LEGAL_CONTACT_EMAIL ?? '',
    privacyEmail: config.LEGAL_PRIVACY_EMAIL ?? '',
    supervisoryAuthority: config.LEGAL_SUPERVISORY_AUTHORITY ?? '',
    vatRegime: config.LEGAL_VAT_REGIME ?? 'ordinary',
  };
}

/**
 * The identity fields that are missing or still hold a placeholder.
 *
 * Used by the launch gate (npm run launch:check) and by the boot check: a
 * deployment that sells subscriptions without a published identity is not
 * launchable, and a placeholder that slipped into the shipped pages is worse
 * than no page at all - it looks compliant without being so.
 */
export function missingIdentityFields(
  identity: LegalIdentity,
  options: { paidService?: boolean } = {},
): string[] {
  const missing: string[] = [];
  for (const field of requiredIdentityFields(identity.entityKind, options)) {
    if (field === 'entityKind') {
      // A natural person cannot issue the invoice a paid subscription needs.
      missing.push('entityKind');
      continue;
    }
    const value = (identity[field as keyof LegalIdentity] ?? '') as string;
    if (value.trim() === '' || isPlaceholderValue(value)) missing.push(field);
  }
  return missing;
}

/**
 * Reserved example domains (RFC 2606) and the reserved `.example` TLD.
 *
 * Matched with a regular expression over the whole value rather than with
 * `includes('example.com')`: a substring check on a hostname is an
 * incomplete sanitisation (the host can appear anywhere in the string), and
 * CodeQL treats it as a security finding for good reason.
 */
const RESERVED_DOMAIN = /@[^@\s]*(\.example\b|example\.(com|org|net)\b)/i;

/** Words that mean "nobody filled this in yet". */
const PLACEHOLDER_WORDS = [
  'changeme',
  'change_me',
  'change-me',
  'tbd',
  'todo',
  'placeholder',
  'xxx',
];

/** True when a value is one of the placeholders that must never be published. */
export function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return true;
  if (RESERVED_DOMAIN.test(normalized)) return true;
  return PLACEHOLDER_WORDS.some((word) => normalized.includes(word));
}
