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
  tradingName: 'DOMINUS',
  entityKind: 'company' as const,
  legalForm: 'SRL',
  shareCapital: 'EUR 10,000.00 fully paid',
  registeredAddress: 'Via Roma 1, 00100 Roma (RM), Italy',
  vatId: 'IT12345678901',
  reaNumber: 'RM-123456',
  registroImprese: 'Registro Imprese di Roma',
  pec: 'example@pec.it',
  contactEmail: 'hello@example.it',
  privacyEmail: 'privacy@example.it',
  supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
  vatRegime: 'ordinary' as const,
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
    expect(text).toContain(IDENTITY.registroImprese);
    expect(text).toContain(IDENTITY.pec);
    expect(text).toContain(IDENTITY.contactEmail);
  });

  it('describes a Cloud deployment without a sale as a waitlist', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    expect(content.status).toBe('cloud_waitlist');
    const text = JSON.stringify(content.documents);
    expect(text).toContain('not open for paid subscriptions');
    expect(text).toContain('No subscription can be bought here');
    // A waitlist is not a shop: no price, no withdrawal policy over a
    // contract that cannot be concluded.
    expect(text).not.toContain('reverse charge');
    expect(text).not.toContain('right of withdrawal');
  });

  it('states the withdrawal right and the reverse charge in the paid cloud terms', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    expect(content.status).toBe('cloud_paid');
    const terms = content.documents.find((d) => d.slug === 'terms');
    const text = JSON.stringify(terms);
    expect(text).toContain('right of withdrawal');
    expect(text).toContain('14 days');
    expect(text).toContain('art. 57(3)');
    expect(text).toContain('reverse charge');
    // The operator does not rely on the art. 59(1)(o) waiver: the consumer
    // keeps the withdrawal right and pays only the service already supplied.
    expect(text).not.toContain('you lose the right of withdrawal');
    expect(text).toContain('do not ask you to waive');
  });

  it('does not claim that the Italian text prevails', () => {
    const paid = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    const waitlist = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    for (const content of [paid, waitlist]) {
      const text = JSON.stringify(content.documents);
      expect(text).not.toContain('Italian version prevails');
      expect(text).toContain('English text is the only binding version');
    }
  });

  it('cites art. 7 of the e-commerce decree, not the Consumer Code', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    const notice = content.documents.find((d) => d.slug === 'legal-notice');
    const text = JSON.stringify(notice);
    expect(text).toContain('art. 7');
    expect(text).toContain('Legislative Decree 70/2003');
    expect(text).not.toContain('art. 7 of the Italian Consumer Code');
  });

  it('lists the sub-processors and the supervisory authority in the privacy notice', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    const privacy = content.documents.find((d) => d.slug === 'privacy');
    const text = JSON.stringify(privacy);
    expect(text).toContain('Hetzner');
    expect(text).toContain('Stripe');
    expect(text).toContain(IDENTITY.supervisoryAuthority);
  });

  it('names the waitlist provider when one is configured', () => {
    const content = buildLegalContent({
      identity: IDENTITY,
      cloudMode: true,
      waitlistUrl: 'https://waitlist.example.net/dominus',
    });
    const text = JSON.stringify(content.documents);
    expect(text).toContain('https://waitlist.example.net/dominus');
    expect(text).toContain('names the provider');
  });

  it('publishes the operator identity in a self-hosted deployment configured with one', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: false });
    expect(content.mode).toBe('community');
    expect(content.status).toBe('community');
    expect(content.identity.entityName).toBe(IDENTITY.entityName);
    const text = JSON.stringify(content.documents);
    // The deployer is the controller: the documents name them, not the DOMINUS
    // authors. No Cloud commercial term leaks into a self-hosted deployment.
    expect(text).toContain(IDENTITY.entityName);
    expect(text).not.toContain('Not applicable');
    expect(text).not.toContain('reverse charge');
    expect(text).not.toContain('right of withdrawal');
  });

  it('says so instead of inventing a controller when community identity is unset', () => {
    const content = buildLegalContent({
      identity: identityFromConfig({}),
      cloudMode: false,
    });
    expect(content.identityPublished).toBe(false);
    const text = JSON.stringify(content.documents);
    expect(text).not.toContain('Not applicable');
    expect(text).toContain('LEGAL_ENTITY_NAME');
    expect(text).toContain('has not published the identity');
  });

  it('offers the AGPL source on every document', () => {
    const content = buildLegalContent({
      identity: IDENTITY,
      cloudMode: true,
      sourceCodeUrl: 'https://example.org/source',
    });
    expect(content.sourceCodeUrl).toBe('https://example.org/source');
    for (const doc of content.documents) {
      expect(JSON.stringify(doc)).toContain('https://example.org/source');
    }
  });

  it('does not promise a refund withheld until the service is returned', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    const text = JSON.stringify(content.documents);
    expect(text).not.toContain('withhold the refund');
    expect(text).toContain('there is nothing to return');
  });

  it('makes the DPA mandatory for a business customer', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    const text = JSON.stringify(content.documents);
    expect(text).not.toContain('may agree a data processing agreement');
    expect(text).toContain('art. 28 GDPR applies and is incorporated into these terms');
  });

  it('does not claim the Community and Cloud have the same feature set', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true, paidService: true });
    const text = JSON.stringify(content.documents);
    expect(text).not.toContain('same feature set');
    expect(text).toContain('managed edition adds multi-tenancy, team seats, single sign-on');
  });

  it('stamps every document with the same update date', () => {
    const content = buildLegalContent({ identity: IDENTITY, cloudMode: true });
    expect(LEGAL_DOCUMENTS_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(content.documents).toHaveLength(3);
    expect(content.updatedAt).toBe(LEGAL_DOCUMENTS_UPDATED_AT);
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
    expect(identity.vatRegime).toBe('ordinary');
  });

  it('defaults to an individual operator', () => {
    expect(identityFromConfig({}).entityKind).toBe('individual');
  });
});

describe('missingIdentityFields', () => {
  it('reports the fields a natural person must publish', () => {
    const identity = identityFromConfig({});
    expect(missingIdentityFields(identity)).toEqual([
      'entityName',
      'registeredAddress',
      'contactEmail',
      'privacyEmail',
    ]);
  });

  it('accepts a complete identity', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: IDENTITY.entityName,
      LEGAL_ENTITY_KIND: IDENTITY.entityKind,
      LEGAL_LEGAL_FORM: IDENTITY.legalForm,
      LEGAL_SHARE_CAPITAL: IDENTITY.shareCapital,
      LEGAL_REGISTERED_ADDRESS: IDENTITY.registeredAddress,
      LEGAL_VAT_ID: IDENTITY.vatId,
      LEGAL_REA_NUMBER: IDENTITY.reaNumber,
      LEGAL_REGISTRO_IMPRESE: IDENTITY.registroImprese,
      LEGAL_PEC: IDENTITY.pec,
      LEGAL_CONTACT_EMAIL: IDENTITY.contactEmail,
      LEGAL_PRIVACY_EMAIL: IDENTITY.privacyEmail,
    });
    expect(missingIdentityFields(identity)).toEqual([]);
  });

  it('rejects a natural person for a paid service even when every field is set', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: 'Ada Lovelace',
      LEGAL_REGISTERED_ADDRESS: 'Via Roma 1',
      LEGAL_CONTACT_EMAIL: 'ada@example.it',
      LEGAL_PRIVACY_EMAIL: 'privacy@example.it',
    });
    expect(missingIdentityFields(identity)).toEqual([]);
    expect(missingIdentityFields(identity, { paidService: true })).toContain('entityKind');
  });

  it('treats a placeholder as missing', () => {
    const identity = identityFromConfig({
      LEGAL_ENTITY_NAME: IDENTITY.entityName,
      LEGAL_ENTITY_KIND: IDENTITY.entityKind,
      LEGAL_LEGAL_FORM: IDENTITY.legalForm,
      LEGAL_SHARE_CAPITAL: IDENTITY.shareCapital,
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
