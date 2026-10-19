// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { buildLegalContent, LEGAL_DOCUMENTS_UPDATED_AT } from '../legal-content.js';
import {
  identityFromConfig,
  isPlaceholderValue,
  missingIdentityFields,
} from '../legal-identity.js';

const IDENTITY = {
  entityName: 'Example Operator SRL',
  entityKind: 'company' as const,
  registeredAddress: 'Via Roma 1, 00100 Roma (RM), Italy',
  vatId: 'IT12345678901',
  reaNumber: 'RM-123456',
  pec: 'example@pec.it',
  contactEmail: 'hello@example.it',
  privacyEmail: 'privacy@example.it',
  supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
};

describe('buildLegalContent', () => {
  it('publishes the three documents', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    expect(content.documents.map((d) => d.slug)).toEqual(['legal-notice', 'terms', 'privacy']);
    expect(content.mode).toBe('cloud');
  });

  it('names the operator identity in the legal notice', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    const notice = content.documents.find((d) => d.slug === 'legal-notice');
    const text = JSON.stringify(notice);
    expect(text).toContain(IDENTITY.entityName);
    expect(text).toContain(IDENTITY.vatId);
    expect(text).toContain(IDENTITY.reaNumber);
    expect(text).toContain(IDENTITY.pec);
    expect(text).toContain(IDENTITY.contactEmail);
  });

  it('states the withdrawal right and the reverse charge in the cloud terms', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    const terms = content.documents.find((d) => d.slug === 'terms');
    const text = JSON.stringify(terms);
    expect(text).toContain('right of withdrawal');
    expect(text).toContain('reverse charge');
    expect(text).toContain('art. 59');
  });

  it('lists the sub-processors and the supervisory authority in the privacy notice', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    const privacy = content.documents.find((d) => d.slug === 'privacy');
    const text = JSON.stringify(privacy);
    expect(text).toContain('Hetzner');
    expect(text).toContain('Stripe');
    expect(text).toContain(IDENTITY.supervisoryAuthority);
  });

  it('does not publish the operator identity in the community edition', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: false });
    expect(content.mode).toBe('community');
    const text = JSON.stringify(content);
    expect(text).not.toContain(IDENTITY.vatId);
    expect(text).not.toContain(IDENTITY.reaNumber);
    // The Cloud commercial terms do not apply to a self-hosted deployment.
    expect(text).not.toContain('reverse charge');
    expect(text).not.toContain('right of withdrawal');
  });

  it('stamps every document with the same update date', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    expect(LEGAL_DOCUMENTS_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(content.documents).toHaveLength(3);
  });
});

describe('identityFromConfig', () => {
  it('reads the operator identity from the configuration', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: 'Example Operator SRL',
      LEGAL_ENTITY_KIND: 'company',
      LEGAL_REGISTERED_ADDRESS: 'Via Roma 1',
      LEGAL_VAT_ID: 'IT12345678901',
      LEGAL_CONTACT_EMAIL: 'hello@example.it',
      LEGAL_PRIVACY_EMAIL: 'privacy@example.it',
    });
    expect(identity.entityName).toBe('Example Operator SRL');
    expect(identity.entityKind).toBe('company');
    expect(identity.vatId).toBe('IT12345678901');
    expect(identity.reaNumber).toBe('');
  });

  it('defaults to an individual operator', () => {
    expect(identityFromConfig({}).entityKind).toBe('individual');
  });
});

describe('missingIdentityFields', () => {
  it('reports every required field of an empty identity', () => {
    const identity = identityFromConfig({});
    expect(missingIdentityFields(identity)).toEqual([
      'entityName',
      'registeredAddress',
      'vatId',
      'contactEmail',
      'privacyEmail',
    ]);
  });

  it('accepts a complete identity', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: IDENTITY.entityName,
      LEGAL_ENTITY_KIND: IDENTITY.entityKind,
      LEGAL_REGISTERED_ADDRESS: IDENTITY.registeredAddress,
      LEGAL_VAT_ID: IDENTITY.vatId,
      LEGAL_REA_NUMBER: IDENTITY.reaNumber,
      LEGAL_PEC: IDENTITY.pec,
      LEGAL_CONTACT_EMAIL: IDENTITY.contactEmail,
      LEGAL_PRIVACY_EMAIL: IDENTITY.privacyEmail,
    });
    expect(missingIdentityFields(identity)).toEqual([]);
  });

  it('treats a placeholder as missing', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: IDENTITY.entityName,
      LEGAL_ENTITY_KIND: IDENTITY.entityKind,
      LEGAL_REGISTERED_ADDRESS: IDENTITY.registeredAddress,
      LEGAL_VAT_ID: 'IT00000000000',
      LEGAL_CONTACT_EMAIL: IDENTITY.contactEmail,
      LEGAL_PRIVACY_EMAIL: 'privacy@dominus.example',
    });
    const missing = missingIdentityFields(identity);
    expect(missing).toContain('privacyEmail');
  });
});

describe('isPlaceholderValue', () => {
  it.each([
    '',
    '   ',
    'privacy@dominus.example',
    'a@example.com',
    'CHANGE_ME',
    'change-me',
    'TBD',
    'todo',
    'placeholder',
    'XXXX',
  ])('flags %j as a placeholder', (value) => {
    expect(isPlaceholderValue(value)).toBe(true);
  });

  it.each(['IT12345678901', 'Via Roma 1, 00100 Roma', 'privacy@dominusofficial.eu'])(
    'accepts %j',
    (value) => {
      expect(isPlaceholderValue(value)).toBe(false);
    },
  );
});
