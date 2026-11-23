// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ContractAcceptanceRepository } from '../../db/repositories/contract-acceptance-repository.js';
import { ContractService, ContractAcceptanceError } from '../contract-service.js';
import { buildLegalContent } from '../legal-content.js';
import { identityFromConfig, validateIdentity } from '../legal-identity.js';

describe('contract acceptance ledger', () => {
  let provider: SqliteProvider;
  let service: ContractService;
  let ref: { version: string; documentHashes: Record<string, string> };

  beforeEach(() => {
    const db = new Database(':memory:');
    provider = new SqliteProvider(db);
    runMigrations(db);
    const legal = buildLegalContent({
      identity: identityFromConfig({
        LEGAL_ENTITY_NAME: 'Example Operator SRL',
        LEGAL_ENTITY_KIND: 'company',
        LEGAL_LEGAL_FORM: 'SRL',
        LEGAL_REGISTERED_ADDRESS: 'Via Roma 1, Roma, Italy',
        LEGAL_VAT_ID: 'IT12345678901',
        LEGAL_REA_NUMBER: 'RM-123456',
        LEGAL_REGISTRO_IMPRESE: 'Registro Imprese di Roma',
        LEGAL_PEC: 'operator@pec.it',
        LEGAL_PRIVACY_EMAIL: 'privacy@example.it',
        LEGAL_CONTACT_EMAIL: 'hello@example.it',
      }),
      cloudMode: true,
      paidService: true,
    });
    ref = { version: legal.version, documentHashes: legal.documentHashes };
    service = new ContractService(new ContractAcceptanceRepository(provider), ref);
  });

  it('rejects an S.r.l. configured with the forfettario regime', () => {
    expect(
      validateIdentity(
        identityFromConfig({ LEGAL_ENTITY_KIND: 'company', LEGAL_VAT_REGIME: 'forfettario' }),
      ),
    ).toContainEqual(expect.stringContaining('cannot use the Italian forfettario'));
  });

  it('hashes each named document so an accepted text can be proved', () => {
    expect(ref.version).toBe('2026-11-24');
    expect(ref.documentHashes.terms).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.documentHashes.privacy).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.documentHashes.terms).not.toBe(ref.documentHashes.privacy);
  });

  it('records terms, privacy and age at signup, from the authenticated route', async () => {
    await service.recordSignup({
      subject: 'buyer@example.com',
      tenantId: 'tenant-1',
      ref,
      termsAccepted: true,
      privacyAccepted: true,
      ageConfirmed: true,
    });
    const rows = await service.listForTenant('tenant-1');
    expect(rows.map((r) => `${r.purpose}:${r.documentSlug}`).sort()).toEqual([
      'signup:age',
      'signup:privacy',
      'signup:terms',
    ]);
  });

  it('refuses signup when the privacy notice was not accepted', async () => {
    await expect(
      service.recordSignup({
        subject: 'buyer@example.com',
        tenantId: 'tenant-1',
        ref,
        termsAccepted: true,
        privacyAccepted: false,
        ageConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(ContractAcceptanceError);
  });

  it('refuses a document version or hash the operator never published', async () => {
    await expect(
      service.recordSignup({
        subject: 'buyer@example.com',
        tenantId: 'tenant-1',
        ref: { version: '1999-01-01', documentHashes: ref.documentHashes },
        termsAccepted: true,
        privacyAccepted: true,
        ageConfirmed: true,
      }),
    ).rejects.toThrow(/published version/);
    await expect(
      service.recordCheckout({
        subject: 'tenant-1',
        tenantId: 'tenant-1',
        ref: {
          version: ref.version,
          documentHashes: { ...ref.documentHashes, terms: 'f'.repeat(64) },
        },
        immediatePerformance: true,
        businessCustomer: false,
      }),
    ).rejects.toThrow(/published version/);
  });

  it('refuses checkout without the immediate-performance request', async () => {
    await expect(
      service.recordCheckout({
        subject: 'tenant-1',
        tenantId: 'tenant-1',
        ref,
        immediatePerformance: false,
        businessCustomer: false,
      }),
    ).rejects.toThrow(/express request/);
  });

  it('refuses a stale hash and accepts a matching checkout', async () => {
    await expect(
      service.requireCheckout({ tenantId: 'tenant-1', ref, needsArt1341: false }),
    ).rejects.toBeInstanceOf(ContractAcceptanceError);

    await service.recordCheckout({
      subject: 'tenant-1',
      tenantId: 'tenant-1',
      ref,
      immediatePerformance: true,
      businessCustomer: false,
    });
    await expect(
      service.requireCheckout({ tenantId: 'tenant-1', ref, needsArt1341: false }),
    ).resolves.toBeUndefined();

    const stale = {
      version: ref.version,
      documentHashes: { ...ref.documentHashes, terms: '0'.repeat(64) },
    };
    await expect(
      service.requireCheckout({ tenantId: 'tenant-1', ref: stale, needsArt1341: false }),
    ).rejects.toThrow(/published version/);
  });

  it('requires the art. 1341 approval and the DPA for a business checkout', async () => {
    await expect(
      service.recordCheckout({
        subject: 'tenant-1',
        tenantId: 'tenant-1',
        ref,
        immediatePerformance: true,
        businessCustomer: true,
      }),
    ).rejects.toThrow(/art\. 1341/);

    await service.recordCheckout({
      subject: 'tenant-1',
      tenantId: 'tenant-1',
      ref,
      immediatePerformance: true,
      businessCustomer: true,
      art1341Approved: true,
      dpaAccepted: true,
      billingCode: 'ABCDEFG',
    });
    await expect(
      service.requireCheckout({ tenantId: 'tenant-1', ref, needsArt1341: true }),
    ).resolves.toBeUndefined();
    const rows = await service.listForTenant('tenant-1');
    expect(rows.map((r) => r.purpose)).toContain('dpa');
    expect(
      rows.find((r) => r.purpose === 'checkout' && r.documentSlug === 'terms')?.billingCode,
    ).toBe('ABCDEFG');
  });
});
